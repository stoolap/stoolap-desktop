//! Signing in to the Claude API with a browser, through Anthropic's `ant`
//! CLI: `ant auth login` keeps an OAuth profile, and each request asks it for
//! a short-lived access token. No API key, and the app never reads the
//! credentials file itself.
//!
//! `ant` is not bundled: on first use the app downloads one pinned release
//! from GitHub, checks it against the SHA-256 below, and keeps it in its own
//! data directory. It runs with a config directory of the app's own, so its
//! sign-in never mixes with the user's own `ant` or Claude Code.

use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

/// The pinned release, at least two weeks old when chosen
pub const VERSION: &str = "2.6.0";

#[cfg(windows)]
const BINARY: &str = "ant.exe";
#[cfg(not(windows))]
const BINARY: &str = "ant";

/// This platform's release archive and its SHA-256, from the release's
/// ant_2.6.0_checksums.txt
fn asset() -> Option<(&'static str, &'static str)> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some((
            "ant_2.6.0_macos_arm64.zip",
            "321b140373330e91a006a66265175fc15c2c28e73f4d2c1ba272ae7e999c1448",
        )),
        ("macos", "x86_64") => Some((
            "ant_2.6.0_macos_amd64.zip",
            "f44442eb4d9e3e2f1332bb334393b225a1dea12f10d9a5e18e30f0088374af61",
        )),
        ("linux", "x86_64") => Some((
            "ant_2.6.0_linux_amd64.tar.gz",
            "0dedb855c97fbee9934f8d067ddcae0592083615b577d128bc4311a03eb9c1c5",
        )),
        ("linux", "aarch64") => Some((
            "ant_2.6.0_linux_arm64.tar.gz",
            "9bd8e6e7fccda6879de713b4726b42a4d18a4cf2571bd96d9911ea47774e52f5",
        )),
        ("windows", "x86_64") => Some((
            "ant_2.6.0_windows_amd64.zip",
            "56a1391feac9ce8d86aa082433b9850a8284ff948d4e895581b5e7b4ad62b435",
        )),
        _ => None,
    }
}

/// Whether browser sign-in can be set up on this platform
pub fn supported() -> bool {
    asset().is_some()
}

/// The app's copy of `ant` and the config directory it signs in with
#[derive(Clone)]
pub struct Ant {
    pub path: PathBuf,
    pub config_dir: PathBuf,
}

impl Ant {
    /// The app's copy under `data_dir`, if it has been downloaded
    pub fn installed(data_dir: &Path) -> Option<Ant> {
        let ant = Ant::at(data_dir);
        ant.path.is_file().then_some(ant)
    }

    fn at(data_dir: &Path) -> Ant {
        Ant {
            path: data_dir.join("tools").join(format!("ant-{VERSION}")).join(BINARY),
            config_dir: data_dir.join("anthropic"),
        }
    }

    /// `ant` with the app's config directory, and without the variables
    /// that would override its signed-in profile
    fn command(&self) -> std::process::Command {
        let mut cmd = std::process::Command::new(&self.path);
        cmd.env("ANTHROPIC_CONFIG_DIR", &self.config_dir)
            .env_remove("ANTHROPIC_API_KEY")
            .env_remove("ANTHROPIC_AUTH_TOKEN")
            .env_remove("ANTHROPIC_PROFILE")
            .stdin(Stdio::null());
        cmd
    }

    /// A fresh access token for the signed-in profile (`ant` refreshes it
    /// when needed), or None when nobody is signed in.
    pub fn access_token(&self) -> Option<String> {
        let out = self
            .command()
            .args(["auth", "print-credentials", "--access-token"])
            .stderr(Stdio::null())
            .output()
            .ok()?;
        let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
        // Only a single bare token counts; anything else is a message
        (out.status.success() && !token.is_empty() && !token.contains(char::is_whitespace))
            .then_some(token)
    }

    /// The browser sign-in: `ant` opens platform.claude.com and the approval
    /// comes back to a local port, so nothing has to be pasted. `ant` gives up
    /// after five minutes without an approval.
    pub async fn login(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.config_dir).map_err(|e| e.to_string())?;
        let mut cmd = tokio::process::Command::from(self.command());
        cmd.args(["auth", "login"])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let child = cmd.spawn().map_err(|e| format!("Could not start ant: {e}"))?;
        let out = tokio::time::timeout(Duration::from_secs(6 * 60), child.wait_with_output())
            .await
            .map_err(|_| "The sign-in was not approved in time. Try again.".to_string())?
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(());
        }
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if msg.is_empty() { "The sign-in did not finish.".into() } else { msg })
    }

    /// Sign out of the app's profile.
    pub fn logout(&self) -> Result<(), String> {
        let out = self.command().args(["auth", "logout"]).output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }
}

/// Download the pinned `ant` release into `data_dir` unless it is there.
pub async fn install(data_dir: &Path) -> Result<Ant, String> {
    if let Some(ant) = Ant::installed(data_dir) {
        return Ok(ant);
    }
    let (name, sha256) = asset().ok_or("Browser sign-in is not available on this platform.")?;
    let url = format!("https://github.com/anthropics/anthropic-cli/releases/download/v{VERSION}/{name}");
    let resp = super::api::client()
        .get(&url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Could not download the sign-in tool: {e}"))?;
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Could not download the sign-in tool: {e}"))?;

    let binary = verify_and_extract(&bytes, sha256, name)?;
    let ant = Ant::at(data_dir);
    let dir = ant.path.parent().ok_or("bad tool path")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // Write next to it and rename, so a half-written file is never run
    let partial = dir.join(format!("{BINARY}.partial"));
    std::fs::write(&partial, &binary).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(&partial, &ant.path).map_err(|e| e.to_string())?;
    Ok(ant)
}

/// Check the archive's SHA-256, then take the `ant` binary out of it.
fn verify_and_extract(archive: &[u8], sha256: &str, name: &str) -> Result<Vec<u8>, String> {
    let digest = Sha256::digest(archive);
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    if hex != sha256 {
        return Err("The downloaded sign-in tool did not match its checksum, so it was not used.".into());
    }
    let mut binary = Vec::new();
    if name.ends_with(".zip") {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive)).map_err(|e| e.to_string())?;
        let mut file = zip.by_name(BINARY).map_err(|e| e.to_string())?;
        file.read_to_end(&mut binary).map_err(|e| e.to_string())?;
    } else {
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive));
        let entry = tar
            .entries()
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .find(|e| e.path().ok().is_some_and(|p| p == Path::new(BINARY)));
        entry
            .ok_or("The download has no ant binary.")?
            .read_to_end(&mut binary)
            .map_err(|e| e.to_string())?;
    }
    if binary.is_empty() {
        return Err("The download has no ant binary.".into());
    }
    Ok(binary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn sha(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    fn zip_with(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(&mut buf);
        for (name, body) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(body).unwrap();
        }
        zip.finish().unwrap();
        buf.into_inner()
    }

    #[test]
    fn takes_the_binary_out_of_a_matching_archive_only() {
        let archive = zip_with(&[("LICENSE", b"Apache"), (BINARY, b"the binary")]);
        let good = sha(&archive);
        assert_eq!(verify_and_extract(&archive, &good, "x.zip").unwrap(), b"the binary");

        // One flipped byte: refused before anything is unpacked
        let mut tampered = archive.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(verify_and_extract(&tampered, &good, "x.zip").unwrap_err().contains("checksum"));

        let no_binary = zip_with(&[("LICENSE", b"Apache")]);
        assert!(verify_and_extract(&no_binary, &sha(&no_binary), "x.zip").is_err());
    }

    #[test]
    fn this_platform_has_a_pinned_release() {
        // The platforms the app is released for
        if cfg!(any(target_os = "macos", all(target_os = "linux", target_arch = "x86_64"), all(windows, target_arch = "x86_64"))) {
            let (name, sha) = asset().unwrap();
            assert!(name.contains(VERSION) && sha.len() == 64);
        }
    }

    /// Downloads the real release: run with `cargo test -- --ignored`
    #[test]
    #[ignore]
    fn installs_the_pinned_release_from_github() {
        let data = std::env::temp_dir().join(format!("stoolap-ant-dl-{}", std::process::id()));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let ant = rt.block_on(install(&data)).unwrap();
        let out = std::process::Command::new(&ant.path).arg("--version").output().unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).contains(VERSION));
        // Not signed in with the app's fresh config dir
        assert!(ant.access_token().is_none());
        std::fs::remove_dir_all(&data).ok();
    }

    #[cfg(unix)]
    #[test]
    fn runs_ant_with_the_apps_own_config_dir() {
        use std::os::unix::fs::PermissionsExt;
        let data = std::env::temp_dir().join(format!("stoolap-ant-{}", std::process::id()));
        let ant = Ant::at(&data);
        std::fs::create_dir_all(ant.path.parent().unwrap()).unwrap();
        // Signed in only when run with the app's config dir and no stray key
        std::fs::write(
            &ant.path,
            format!(
                "#!/bin/sh\n[ \"$ANTHROPIC_CONFIG_DIR\" = \"{}\" ] && [ -z \"$ANTHROPIC_API_KEY\" ] && echo tok-123 || exit 1\n",
                ant.config_dir.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&ant.path, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(Ant::installed(&data).is_some());
        assert_eq!(ant.access_token().as_deref(), Some("tok-123"));
        std::fs::remove_dir_all(&data).ok();
    }
}
