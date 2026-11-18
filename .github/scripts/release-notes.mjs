// Print the release note for a tag: its "## <tag>" section of CHANGELOG.md,
// without the heading. Exits 1 when the section is missing or empty, so a
// release can't go out without a note.
//
//   node .github/scripts/release-notes.mjs v0.5.1
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function releaseNotes(changelog, tag) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${tag}`);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const notes = lines.slice(start + 1, end).join("\n").trim();
  return notes || null;
}

// Run directly, not imported. Compare URLs: on Windows the path is D:\..., so
// "file://" + path would never match and the note would come out empty.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tag = process.argv[2];
  const notes = tag && releaseNotes(readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8"), tag);
  if (!notes) {
    console.error(`CHANGELOG.md has no "## ${tag}" section: add the release note before tagging.`);
    process.exit(1);
  }
  console.log(notes);
}
