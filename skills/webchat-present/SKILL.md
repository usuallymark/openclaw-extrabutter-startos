---
name: webchat-present
description: "Give the user a file as a download button in the webchat. Use when the user is chatting through the webchat and asks for a file (a document, spreadsheet, image, export) or when a file is the natural way to deliver your result."
---

# webchat-present — hand files to the webchat user

The webchat shows a download card for any line in your reply of the form
`[DOWNLOAD:<token>:<filename>:<mime-type>]`. You get that line by uploading the
file with the helper below. Links expire after 24 hours.

## How

1. Write the file somewhere you can read it (e.g. under `/data/.openclaw/workspace/`).
2. Run:

   ```bash
   node /opt/webchat/present.mjs /path/to/file.pdf
   ```

   Optional arguments: a MIME type, then a display name:
   `node /opt/webchat/present.mjs /tmp/out.bin application/pdf "Q3 report.pdf"`.
3. The command prints one line like
   `[DOWNLOAD:3f2a…:report.pdf:application/pdf]`. Put that exact line on its
   own line in your reply. Do not change it, wrap it in code formatting, or
   describe the token.

## Notes

- Max file size is 50 MB.
- Only works when the user is chatting through the webchat. In other channels
  (Telegram, WhatsApp, the Control UI) deliver files the usual way for that
  channel.
- If the command fails, tell the user the file could not be attached and where
  it was saved instead.
