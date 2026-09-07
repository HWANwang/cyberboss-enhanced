# Switching a saved WeChat account

Cyberboss stores account tokens, user IDs, context tokens, and bindings in the configured state directory. None of those files should be committed.

From the project directory, list saved accounts:

```powershell
.\scripts\switch-weixin-account.ps1 -List
```

Switch by a full account ID or unique prefix:

```powershell
.\scripts\switch-weixin-account.ps1 -Account <account-id-or-prefix>
```

The script validates the saved account, backs up the external environment file, updates `CYBERBOSS_ACCOUNT_ID`, restarts the bridge, verifies the PID, and checks that exactly one bridge is active. It loads configuration from `CYBERBOSS_ENV_FILE`, then `%USERPROFILE%\\.cyberboss\\.env`, and finally the legacy project `.env` if present.

After switching, send one inbound message from that WeChat account. This refreshes the account-scoped context token and confirms the inbound path before relying on automatic replies.

## Direct delivery test

After an inbound message has refreshed the context token:

```powershell
.\scripts\switch-weixin-account.ps1 -Account <account-id-or-prefix> -DirectTest
```

The test bypasses the model and thread layers. It sends one message through the WeChat API and prints status metadata only; it never prints the bot token or context token.

## Recovery notes

- Do not copy context tokens between accounts.
- Keep account ID, user ID, sync buffer, and context-token files together in the same state directory.
- If startup fails, inspect `cyberboss.log` and `backups/` under the configured state directory.
- If process inspection is unavailable, run PowerShell with the permissions required by your local process policy.
