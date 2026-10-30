#!/bin/sh
set -eu
runtime=/workspace/runtime
managed=${ISOLATED_HARNESS_MANAGED_RUNTIME:-}
image_python=/opt/isolated-harness/python
if [ -n "$managed" ]; then
  ln -sfn "$managed/python" "$runtime/python"
  ln -sfn "$managed/venv" "$runtime/venv"
  [ ! -e "$managed/pillow" ] || ln -sfn "$managed/pillow" "$runtime/pillow"
  browser_source="$managed/browsers"
  export VIRTUAL_ENV="$runtime/venv"
  export PATH="$VIRTUAL_ENV/bin:$PATH"
elif [ -d "$image_python" ]; then
  ln -sfn "$image_python" "$runtime/python"
  ln -sfn "$image_python" "$runtime/venv"
  browser_source=/opt/ms-playwright
else
  browser_source=/opt/ms-playwright
fi
mkdir -p "$runtime/browsers/.links"
for component in "$browser_source"/*; do
  [ -e "$component" ] || continue
  ln -sfn "$component" "$runtime/browsers/$(basename "$component")"
done
exec "$@"
