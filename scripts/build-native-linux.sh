#!/usr/bin/env bash
# Run only in a disposable Linux build environment with Node.js 26 already available.
# Downloads npm dependencies inside its own staging directory. Never starts Wiki.js.
set -euo pipefail

checkout="${1:?Pass the candidate checkout path}"
output="${2:?Pass the output directory}"
commit="${3:?Pass the exact candidate commit SHA}"
release_base=49fb7d4f8228a3862db7ab5552caf2e587f0c16f
build_base=3f28e7dedf52d01be661e37d0298b7391d06facf

# Pin the run to its triggering commit, not a moving branch or the original release alone.
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo 'Need a full candidate commit SHA.' >&2; exit 1; }
release="3.1.0-image-links.${commit:0:12}"
test "$(uname -s)" = Linux || { echo 'A native Linux builder is required.' >&2; exit 1; }
node -e 'if (+process.versions.node.split(".")[0] !== 26 || process.arch !== "x64") throw Error("Use Node.js 26.x on Linux x64")'
test "$(git -C "$checkout" rev-parse HEAD)" = "$commit" || {
  echo "Check out the candidate commit $commit first." >&2; exit 1;
}
git -C "$checkout" merge-base --is-ancestor "$build_base" "$commit" || {
  echo "Candidate must include the confirmed 3.1 build base $build_base." >&2; exit 1;
}
test -z "$(git -C "$checkout" status --porcelain)" || {
  echo 'The source checkout must be clean.' >&2; exit 1;
}

mkdir -p "$output"
output="$(cd "$output" && pwd)"
stage="$(mktemp -d "$output/.build-image-links.XXXXXX")"
# Preserve diagnostic logs even if a regression test or compile fails.
mkdir -p "$output/logs"
trap 'cp "$stage/"*.log "$output/logs/" 2>/dev/null || true' EXIT
mkdir "$stage/source"
git -C "$checkout" archive "$commit" | tar -xf - -C "$stage/source"
export npm_config_cache="$stage/npm-cache"
export npm_config_audit=false
export npm_config_fund=false

# Distinguish this candidate from the installed official 3.1.0 package.
node --input-type=module - "$stage/source" "$release" <<'JS'
import fs from 'node:fs'
import path from 'node:path'
for (const workspace of ['frontend', 'backend']) {
  const file = path.join(process.argv[2], workspace, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
  pkg.version = process.argv[3]
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
}
JS

(cd "$stage/source/frontend" && npm ci --ignore-scripts && npm run visual:check:image-links && npm run build) 2>&1 | tee "$stage/frontend.log"
(cd "$stage/source/blocks" && npm ci --ignore-scripts && npm run build) 2>&1 | tee "$stage/blocks.log"

# Additional validation; TypeScript runs directly under Node, so there is no backend compile.
(cd "$stage/source/backend" && npm ci --ignore-scripts && npm run typecheck && npm run visual:check:protocol) 2>&1 | tee "$stage/typecheck.log"

dist="$stage/dist"
mkdir -p "$dist/blocks" "$dist/backend"
cp -R "$stage/source/assets" "$dist/assets"
cp -R "$stage/source/blocks/compiled" "$dist/blocks/compiled"
(cd "$stage/source/backend" && tar --exclude='./node_modules' -cf - .) |
  (cd "$dist/backend" && tar -xf -)
cp "$stage/source/LICENSE" "$stage/source/config.sample.yml" "$dist/"
(cd "$dist/backend" && npm ci --omit=dev --ignore-scripts) 2>&1 | tee "$stage/runtime-dependencies.log"

# Exercise the native image dependency on the actual Linux builder.
(cd "$dist/backend" && node --input-type=module - <<'JS'
import sharp from 'sharp'
const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#fff' } }).png().toBuffer()
if ((await sharp(png).metadata()).width !== 2) throw Error('Sharp image smoke test failed')
console.log('Sharp native image processing passed')
JS
) 2>&1 | tee "$stage/sharp.log"

test -s "$dist/assets/index.html"
test -s "$dist/assets/_assets/renderer.js"
test -s "$dist/blocks/compiled/blocks.manifest.json"
test -s "$dist/backend/index.ts"
test ! -e "$dist/config.yml"

platform="$(node -p 'process.platform + "-" + process.arch')"
artifact="$output/wiki-js-$release-$platform.tar.gz"
test ! -e "$artifact" || { echo "Refusing to overwrite $artifact" >&2; exit 1; }
tar -czf "$artifact" -C "$dist" .
(cd "$output" && sha256sum "$(basename "$artifact")") > "$artifact.sha256"
{
  printf 'release=%s\ncommit=%s\nrelease_base=%s\nbuild_base=%s\nplatform=%s\n' "$release" "$commit" "$release_base" "$build_base" "$platform"
  node --version
  npm --version
  sha256sum "$stage/source/"{frontend,blocks,backend}/package-lock.json
  printf 'logs=%s\n' "$stage"
} > "$artifact.build-info.txt"
printf 'Built %s\nEvidence remains in %s\n' "$artifact" "$stage"
