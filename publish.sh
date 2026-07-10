#!/bin/zsh
# Publish document changes to the live site.
#
# Run this after editing anything in the SOP Consolidation folder (or the
# staff docs in source_docs/). It recompiles the data files, commits, and
# pushes; Render redeploys the site automatically on push.
set -e
cd "$(dirname "$0")"

echo "Recompiling data from the SOP Consolidation corpus..."
python3 parse_docs.py
python3 build_corpus.py

git add -A
if git diff --cached --quiet; then
  echo "No changes to publish. The site already matches your documents."
  exit 0
fi
git commit -m "Update documents ($(date '+%Y-%m-%d %H:%M'))"
git push
echo ""
echo "Pushed. Render will rebuild the site in about a minute."
