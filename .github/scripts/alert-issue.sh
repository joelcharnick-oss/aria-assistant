#!/usr/bin/env bash
# Opens (or comments on) a single "deploy-alert" GitHub issue when a check
# fails, and closes it when checks pass again. A new issue in your own repo
# emails you (as the repo's watcher) regardless of who or what triggered the
# workflow, which is more reliable than relying on Actions failure emails alone.
#
# Usage: alert-issue.sh fail "<check name>" <markdown-file>
#        alert-issue.sh pass "<check name>"
# Needs GH_TOKEN (the workflow's github.token with issues: write) and GITHUB_REPOSITORY.
set -euo pipefail

action="$1"; check="$2"; body_file="${3:-}"
label="deploy-alert"
run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-}"

gh label create "$label" --repo "$GITHUB_REPOSITORY" --color B60205 \
  --description "Automated alert: live app not deployed or unhealthy" >/dev/null 2>&1 || true

title="⚠️ aria-assistant: ${check} failed"
# One open issue per check, so a passing deploy check never closes an
# unrelated open health-check alert (and vice versa).
existing="$(gh issue list --repo "$GITHUB_REPOSITORY" --label "$label" --state open \
  --json number,title --jq "map(select(.title == \"${title}\")) | .[0].number // empty")"

if [[ "$action" == "fail" ]]; then
  msg="$(cat "$body_file")"$'\n\n'"Check: **${check}** · [workflow run](${run_url})"
  if [[ -n "$existing" ]]; then
    gh issue comment "$existing" --repo "$GITHUB_REPOSITORY" --body "$msg"
  else
    gh issue create --repo "$GITHUB_REPOSITORY" --label "$label" \
      --title "$title" --body "$msg"
  fi
elif [[ "$action" == "pass" ]]; then
  if [[ -n "$existing" ]]; then
    gh issue close "$existing" --repo "$GITHUB_REPOSITORY" \
      --comment "✅ **${check}** passed again ([workflow run](${run_url})). Closing automatically."
  fi
fi
