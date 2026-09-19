#!/bin/bash
# Launch MacPuffin and open it in the default browser.
cd "$(dirname "$0")" || exit 1
exec node server.js
