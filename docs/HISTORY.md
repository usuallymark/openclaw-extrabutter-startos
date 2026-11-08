# History

What changed in each release of OpenClaw Extra Butter, newest first, followed by
older designs and incidents that explain why some things are the way they are.
How the package works today is in the [README](../README.md); each release's
notes are also shown by StartOS when you update, and live in
`startos/versions/`.

Versions are `<OpenClaw version>:<package revision>`: `2026.10.1:45` is the
45th package release on OpenClaw 2026.10.1. Releases are on the
[GitHub releases page](https://github.com/usuallymark/openclaw-extrabutter-startos/releases).

## Releases

### 2026.10.1:45

Usage and Cost now counts every model call.

- **Usage and Cost, the Spending line and the Spending Alert showed too little.** OpenClaw 2026.10 stores longer replies compressed, and those were not counted, often about a third of the cost. They are now. Expect the figures, and the daily total the alert compares with your limit, to go up; check your Spending Alert limit.
- **Long app reports:** the apps agent asks for compact reports when a job may list many messages or events, and the main agent asks again for a narrower job instead of guessing when a report arrives cut off.

### 2026.10.1:44

Easier report screens, and no more double events.

- **Agent Activity** has a small form: which service, which period (24 hours, 7 days, 30 days, everything) and changes only. The result starts with a one-line count of each service's changes; each part opens on its own.
- **Usage and Cost** starts with a one-line summary and opens each part on its own. It now names each agent's model and the form that sets it, and counts the contacts agent among the helpers.
- **Configure Calendar** shows under "Also Trust Email's Trusted Senders" who is trusted now: your Trusted Organizers together with Configure Email's Trusted Senders.
- **Calendar:** when a calendar link and a shared calendar show the same calendar, each event is listed once.

### 2026.10.1:43

Works the same on StartOS 0.4.0.2 and later, 0.4.1 included.

- **No StartOS update needed.** This package still installs and runs on StartOS 0.4.0.2 and later. Its own uses of start-cli (Login to StartOS, Revoke StartOS Access, the Server Access line, the server snapshot) were checked against every StartOS from 0.4.0.2 to 0.4.1.2.
- **If you let the agent manage your server on StartOS 0.4.1 or later:** a few start-cli commands behave differently there (listing and ending sign-in sessions, installing from a signer your server does not trust). The agent now knows and points you to the web UI (System → Active Sessions, System → Trusted Keys) instead of retrying.

### 2026.10.1:42

Releases are signed by one fixed key.

- **Until now every release was signed by a new, random key**, so StartOS could not be told to trust this package's releases. From this release on, all are signed by the same key, shown on each release's GitHub page.
- **On StartOS 0.4.1 and later:** add that key once under System → Trusted Keys → Add key (Packages on), and sideloading an update no longer asks "Install untrusted software?".

### 2026.10.1:41

Ready for StartOS 0.4.1; clearer help texts.

- **Server Access stays truthful on StartOS 0.4.1.** StartOS 0.4.1 changed an answer the line relied on, so a signed-in start-cli would have shown as "not signed in". The line now checks the sign-in in a way that works on every StartOS 0.4 release, and shows an unclear result as a warning instead of as signed out.
- **Server Access looks like what it means:** signed out (the safe choice) is a grey dash instead of a green check, and signed in, which gives the agent root on the server, is an orange warning.
- **Help texts corrected and shortened:** the calendar choices (now "Read + invitations by mail (no calendar account)"), calendar links, sending and routine mailings; the email and calendar agent models; the apps agent now mentions contacts.
- **Setup guide corrected:** the calendar account field's current name, the Vaultwarden items for calendar and contacts, troubleshooting the vault, and two StartOS 0.4.1 notes: confirming a sideloaded package, and API tokens to check under System → Active Sessions after Revoke StartOS Access.

### 2026.10.1:40

Health lines in a useful order; no more login nag.

- **The health lines are in a fixed order:** Web Interface, Webchat, Vault and Qdrant first, then Mail, Calendar and Contacts, then Spending and Server Access, and the external services last. StartOS sorts them by an internal name, which until now put Calendar and Contacts at the top and Mail among the external services.
- **No more "Login to StartOS" task at every start.** Leaving start-cli signed out is the safe choice, and the Server Access line already shows it. The action is still under Maintenance when you want it.

### 2026.10.1:39

A refused sign-in now tells you where to fix it.

- **When the mailbox refuses the password, or Google or the CalDAV server refuses a calendar or contacts sign-in**, the service page gets a task that opens Configure Email, Configure Calendar or Configure Contacts. Its text says what was refused and where the new password or sign-in goes (Vaultwarden or the form).
- The task goes away by itself once the sign-in works again, and comes back within 10 minutes if you open the form without fixing it. A server that is only unreachable raises no task.
- Also for a CalDAV account whose password was refused while calendar links keep working.

### 2026.10.1:38

Tidier actions, safer approvals.

- **Actions are grouped:** Daily (Review Agent Actions, Agent Activity, Usage and Cost, Spending Alert), Email, Calendar, Contacts, Setup, Channels and Maintenance.
- **Review Agent Actions picks no decision for you.** Choose the request, and its details (recipients, subject, why it waits, when it expires) are shown right under the Decision field. Only the choices that apply are offered: calendar requests get Approve or Reject; "make this a routine mailing" is greyed out, with the reason, for replies, forwards, invitations and mail without a subject.
- **Review Agent Actions is greyed out while nothing waits**, and opens again when an agent asks (the task appears at the same time).

### 2026.10.1:37

Calendars at iCloud, Fastmail, Nextcloud (CalDAV).

- **New in Configure Calendar: a CalDAV account** (iCloud, Fastmail, Nextcloud and other CalDAV servers) instead of Google, with an app password (pasted, or Vaultwarden item "caldav"). The server is found from your address (iCloud, Fastmail and Yahoo by name, otherwise the domain's own CalDAV address), or you enter it.
- **Read** every calendar of the account, like calendar links (repeating events, time zones, the same checks and warnings). **Write mode** keeps a calendar of the assistant's own on that account, under the same rules as with Google: guests only from your allowed list, anything with guests waits for your approval, and the server sends the invitations.
- A change is made only on the version the assistant last saw: if the event was changed on another device meanwhile, nothing is overwritten.
- HTTPS only; the password goes only to the calendar server itself, and one the server refused is not sent again.
- **New action: Look Up Calendar Server** shows the server and calendars that would be found, without saving anything.

### 2026.10.1:36

Fix: Fastmail found again.

- **Look Up Mail Servers and "find servers automatically" said Fastmail needs a browser sign-in.** Fastmail's own settings file now offers only that, but Fastmail still accepts app passwords, and Thunderbird's provider directory lists them. The lookup now goes on to the other sources when one offers only a sign-in, and reports the sign-in only when no source offers a password login.

### 2026.10.1:35

Mail servers found automatically.

- **New in Configure Email: "Other provider (find servers automatically)".** Enter the address and password; saving finds the IMAP and SMTP servers the way Thunderbird does (the provider's own settings, Thunderbird's provider directory, your domain's mail server, DNS records) and saves them as "Other IMAP/SMTP provider", where you can see and change them. A Google address is saved as Gmail.
- **New action: Look Up Mail Servers.** Shows what would be found for an address, without saving anything.
- Only encrypted servers with password login are used, and the password is never part of the lookup. Outlook.com, Hotmail and Microsoft 365 no longer accept passwords from mail apps; the lookup says so instead of trying.

### 2026.10.1:34

Fix: "in your contacts" for a contact just added.

- **A contact added in the assistant's Google account could be missed for a while.** When its copy was older than 15 minutes, the contacts check for mail and calendar answered from that old copy, while your assistant's own contacts lookup, a moment later, already saw the new contact. The contacts service now reads Google again every 15 minutes on its own, and a check that still finds an older copy waits briefly for the new one.

### 2026.10.1:33

Known contacts in mail and calendar.

- **New: "in your contacts".** With an address book connected (Configure Contacts), your assistant now says when an email's sender or an event's organizer is in your contacts. That ranks below your trusted lists, and it is only said when the sender is checked: a mail your mail server verified, or an event made in Google.
- **A new warning:** when the address is in your contacts but the sender is not checked (an unverified mail, an emailed invitation), your assistant warns you that someone may be posing as that contact.
- The email and calendar services never see your contacts: they only ask the contacts service "is this address in the contacts?" and get yes or no.
- Mail lists and searches now show whether each sender was verified, without opening the message.

### 2026.10.1:32

Fix: the vault after 2026.10.1:31.

- **The vault found no master password after updating to :31.** The new contacts service's user was added to the image before the vault's, which changed the vault user's number, so its saved files (including the master password) no longer counted as its own. The service users now have fixed numbers (the same as before :31; contacts gets its own), and each service gives the files in its own folder back to its user at start. Nothing needs to be entered again.

### 2026.10.1:31

Contacts, read only.

- **New: Configure Contacts.** Your assistant can look up your address book ("Sam's number", "who is this address?", "birthdays this month") through a new contacts agent, the only agent that reads contacts. Read only: nothing is ever changed.
- **Two sources:** a vCard file exported from any app (Google, iPhone, Outlook), imported into the contacts service's own folder where the agents cannot read it; or the contacts of the assistant's own Google account, with a sign-in that can only read contacts.
- New **Contacts Service** line on the service page.
- Usage and Cost: scheduled jobs now show their schedule, and jobs without an agent show "default (main)".

### 2026.10.1:30

Usage and Cost: see what the AI models cost.

- **New action: Usage and Cost.** The model cost per agent (today, 7 and 30 days, with tokens and the model each uses), per day for the last two weeks, and how often each scheduled job ran. The numbers are the ones OpenClaw records for every model call with the provider's prices; no message text is shown.
- **New Spending line** on the service page: today's and the week's cost, checked every 10 minutes.
- **New action: Spending Alert.** Set a daily limit; above it the Spending line turns red and you get one notification (and ntfy) that day.

### 2026.10.1:29

Configure Calendar: switching modes without surprises.

- **The Calendar choice now shows only the fields that mode needs.** Read only asks for the Google sign-in or none, Read + write (Google) for the sign-in and the own calendar's name, Read + invitations by mail (no Google) for the time zone. A half-finished switch can no longer be saved.
- **Switching back keeps what you had.** Each mode's fields keep their saved values (sign-in choice, own calendar name, time zone, hold setting) and come back as you left them.
- **Invitations by mail is greyed out until Configure Email can send them,** and the description says what is missing, instead of an error after Save.

### 2026.10.1:28

Invitations by mail: add events to your calendars without Google.

- **New Calendar choice in Configure Calendar: "Read + invitations by mail"** (without a Google account). When you ask for an event, the calendar agent sends a normal calendar invitation by email to its guests (you and the people on your trusted lists), and their calendar apps put it on their calendars. Changes and cancellations go out as updates.
- **Your mail rules decide:** invitations are sent by the mail service like any other mail. Never Send To always wins, addresses on Send Automatically To get them straight away, anyone else waits for you in Review Agent Actions, and "Hold Every New Event" holds them all. The calendar service never gets the email password.
- **Answers are filed:** your guests' replies (accepted, declined) to these invitations are moved out of the Inbox into the folder "Calendar Replies".
- **Time Zone** setting in Configure Calendar for use without a Google account.

### 2026.10.1:27

Security: the vault moves out of the agents' reach.

- **A separate vault service now holds Vaultwarden.** Until now every agent with a shell could read the master password and every vault item, including the email password and the Calendar sign-in, and so could send mail or change your calendar without the email and calendar services' rules and your approvals. Now rbw, its keys and the master password belong to the vault service alone; agents ask it.
- **Items that belong to a service go only to that service**: the email password (while Configure Email uses Gmail or IMAP), the Calendar sign-in and your calendar links' items (while Calendar is on). Every other item works for every agent as before (NAS, Crawl4AI, n8n, ntfy, Gitea and your own), through getcred and rbw get as before. Agents can no longer add, edit or delete vault items; do that in Vaultwarden.
- **Configure External Services' settings moved to a folder only the package can read**, so an agent can no longer change the Vaultwarden address it signs in to, your host mappings or your trusted certificates.
- Agent Activity lists which vault items were asked for and which were refused.
- The first start signs in to Vaultwarden again from a new place, so Vaultwarden may report a new device.

**After installing, change what the agents could read until now**: the mail app password (then save it in Vaultwarden or Configure Email), the Google Calendar sign-in (sign in again and remove the old access in your Google account), each calendar link's secret address, and your Vaultwarden master password (then enter it in Configure External Services).

### 2026.10.1:26

Security fixes only.

- **Webchat: every profile needs a PIN.** The webchat reaches the main agent and all its tools, and a profile without a PIN was open to anyone who could reach its address. Such a profile is now closed until it has one; Configure Webchat will not save a profile without a PIN, and new PINs are 6 to 12 digits. If ntfy is set up, you are notified when someone keeps entering wrong PINs.
- **The email and calendar services hold their rules against the main agent's shell.** The agent's user could rename the services' folders and put its own sending rules and approvals in their place, or make the package write into them through a link, and a race in the mail service's start could give it root in the container. All three are closed: /data now belongs to root (sticky), the package removes links before writing into the agent's folders, the services accept only rules and approvals exactly as the package writes them, and the mail service's start changes files by descriptor.
- **Never Send To** now also blocks the same address written another way (sam+anything@, Gmail with dots) and, for @domain, its subdomains.
- **HTML mail** checks also refuse CSS escapes, image-set(), @font-face, comments holding markup (Outlook shows <!--[if mso]> blocks), and links that a browser would open somewhere other than the domain shown; international domains are shown in their xn-- form in Review Agent Actions.
- **Calendar links:** a whole download ends after 30 seconds however slowly the server sends; a link never reaches this server itself, and reaches your own network only when the link itself is there (never by a redirect). A feed whose recurring events repeat absurdly often can no longer keep the calendar busy for minutes per question.
- **Server Access** health line: while start-cli is signed in (Login to StartOS), it warns that the agent then has root on the whole server, so the email and calendar rules do not hold against it.

### 2026.10.1:25

Calendar: who made an event, told correctly.

- **Events on calendars shared with the assistant** were marked as made by the assistant's own account when their calendar's owner made them (and so was a holiday calendar's every event). Now only the account's own calendars count as its own; the owner of a shared calendar is checked against your Trusted Organizers like anyone else, and such events are marked as the calendar's own.
- The calendar agent's status now lists each calendar link and whether it can be read.

### 2026.10.1:24

Calendar links: read your calendars without any Google setup.

- **Calendar Links in Configure Calendar.** Paste a calendar's secret iCal address (Google's "Secret address in iCal format", an iCloud public calendar link, an Outlook ICS link) or keep it in Vaultwarden, and the calendar agent can list, search and read those events. Read only, and no Google Cloud project or sign-in needed: choose *No Google account (calendar links only)*. Links also work next to a Google sign-in.
- Recurring events, moved or cancelled single dates and time zones are handled as in Google Calendar. The secret address never reaches the agents or the logs, and the agent marks these events as from a calendar link.
- The Calendar Service line now says how many calendar links can be read, with a warning for each one that cannot.

### 2026.10.1:23

Routine mailings: per calendar month, and pick recipients from a list.

- **"At Most per Month" now means per calendar month** (it counted 30 days). Monthly issues sent on the 1st are sometimes only 28 to 30 days apart and would have waited for approval for no reason.
- **Pick a mailing's To and Bcc from a list** of the addresses you entered before (Trusted Senders, Send Automatically To, the calendar's Trusted Organizers) instead of typing them again; a field below each takes any other address.

### 2026.10.1:22

Routine mailings, and a say in self-learning.

- **Routine mailings:** approve a newsletter once with "Approve and make this a routine mailing" (Review Agent Actions), and later issues go out without asking when they match: the same recipients, a subject starting the same way, the same kind of attachments, not more often than allowed (one a month to begin with), no hidden instructions. You get a notification for each. Anything else still waits for you and says why. Manage them in Configure Email → Sending → Routine Mailings, with a Paused switch.
- **Self-learning in Configure Agents:** choose whether OpenClaw may change the skills it learned by itself (Automatic, OpenClaw's default), only propose changes for you to approve (recommended), or not learn at all.
- An HTML mail's page title no longer counts as hidden text.

### 2026.10.1:21

HTML mail, longer approvals with a reminder, calendar fixes.

- **The assistant can send HTML mail** (a newsletter, say). It writes the HTML into the workspace folder mail-outbox; pictures are files there too and are embedded in the mail. Pictures loaded from other websites, scripts, forms and hidden instructions are refused. HTML mail always waits for your approval, and Review Agent Actions shows where its links go, its pictures and any hidden text.
- **Waiting requests expire after 5 days instead of 3**, for mail and calendar, and you get a reminder (notification and ntfy) the day before.
- **Calendar:** the health line says "read + write" in write mode (it said "read only"), and the assistant's own calendar follows the account's time zone (a new account's calendar could start out in UTC).

### 2026.10.1:20

New: the apps agent.

- **Your main agent now asks one apps agent about mail and calendars.** The apps agent passes each job to the email or calendar agent and brings their reports back unchanged. Your main agent carries one set of instructions instead of one per app, and the apps agent has nothing but that one job: no shell, no files, no passwords.
- **The email and calendar agents answer only requests that come through the apps agent.** If your main agent's own notes say to ask them directly, change that to the apps agent.
- **New action: Configure Apps Agent** for its name, model and extra instructions. A persona goes in its SOUL.md and IDENTITY.md.
- Configure Agents no longer lists the calendar agent (it is managed by Configure Calendar), like the email agent.

### 2026.10.1:19

Fix for updates that stall at 80%.

- **A health check that hangs no longer blocks stopping or updating the service.** Twice an update sat at 80% because the old version never stopped; the stop log showed why: two checks (Gitea and Ollama) had been stuck for hours, and the stop waited for them. Every check now gives up after 2 minutes (or 20 seconds once a stop has begun), shows as failed for that round and runs again as usual.

### 2026.10.1:18

Agent Activity, and steadier warnings about hidden text.

- **Email Activity is now Agent Activity** and covers Calendar too: what the calendar agent read, added, changed and cancelled, what waited for you and your decisions, next to the email log. Each line says [Email] or [Calendar].
- **Hidden text is checked by the service itself.** Text a person would not see in an email (or an HTML event description) is still removed before the agent reads it; now it is also searched for instructions to an AI. A match sets a new warning, `hidden_injection`, which the agents pass on every time instead of depending on how they read the message.
- **Fewer false "hidden text" counts:** style sheets and HTML comments no longer count as hidden text.

### 2026.10.1:17

Small Calendar fixes.

- **No false "someone else added this" warning** on events on the agent's own calendar.
- **The agent reports the exact saved times**, with the time zone, after adding, changing or cancelling an event (or when it waits for your approval).
- **Own Calendar Name now shows its default ("Assistant") as a real value** you can change, and explains how to rename the calendar later.

### 2026.10.1:16

Calendar: the assistant can keep a calendar of its own.

- **New mode in Configure Calendar: Read + write on its own calendar.** The calendar agent can add, move and cancel events on one calendar of its own (you name it), and invite you and your family. It still cannot change your calendars or answer invitations; Google itself refuses that.
- **Your approval for anything with guests.** Before Google emails anyone, the request waits in Review Agent Actions (a task appears), showing the event, the guests and why it waits. Optionally hold every new event, with or without guests. Only addresses on your trusted lists can be invited.
- **Trusted Organizers can reuse Email's Trusted Senders** (on by default), so the family's addresses are typed once.
- Write mode needs a new sign-in with one more permission; Instructions → Calendar Setup has the command.

### 2026.10.1:15

Calendar, read only.

- **New: Configure Calendar.** Your assistant can read the Google calendars of its account, including the ones you share with it: what is on, when something is, who invited whom. A separate calendar agent does the reading; it has only the calendar tools (no shell, no passwords, no web), and it cannot add, change, accept or delete anything. Off until you turn it on.
- **Invitations are treated like mail from strangers.** Event text is shown as untrusted content with hidden text removed, and each event says whether it came from the account itself, a Trusted Organizer, someone else, or an emailed invitation whose organizer can't be checked.
- **Sign in once on your computer** with the included script (tools/google-signin.py). It asks only to read calendars. Keep the sign-in in Vaultwarden or paste it in the form. The setup guide (Instructions → Calendar Setup) has every step, including the Google settings that stop invitations from strangers.
- **Stop logging.** If an update ever stalls at 80% again, the package log now shows which check the old version was waiting on.

### 2026.10.1:14

Groundwork for Calendar and other Google apps. Email works exactly as before.

- **Review Outgoing Mail is now Review Agent Actions.** It is the one place you approve what your agents want to do. Today that is still only mail held by your sending rules; later, things like calendar invitations will appear there too. Each request shows which agent it comes from. Mail waiting from before the update is still listed and can be approved.
- **The mail service's building blocks are now shared**, so the next isolated services (Calendar first) are built the same way: their own user, no secrets in the agent's reach, and your approval for anything held.

### 2026.10.1:13

Small fix.

- **Email Activity shows the whole log**, line by line, with a copy button and a download (email-activity.txt). It showed everything squeezed into a single line before.

### 2026.10.1:12

Fix for email attachments.

- **Attachments on outgoing mail work.** Drafts with a file from the workspace folder mail-outbox failed with "Permission denied": the mail service runs as its own user, which cannot pass through OpenClaw's private folder (/data/.openclaw). The mail service now gets the two mail folders handed over when it starts, so OpenClaw's folder stays private.
- The same applies to copying attachments from trusted senders into mail-inbox.
- File errors are reported to the email agent in plain words instead of a bare error name.

### 2026.10.1:11

Fix for 2026.10.1:10.

- **A restart no longer hangs, and no longer holds up a server reboot.** In 2026.10.1:10 the Mail Service check also raised the approval task, sent the alerts and cleared the email agent's idle conversation. StartOS waits for a running check before it stops a service, and a restart that began during one of those jobs waited for good; a server reboot then waited behind it. The check now only reads the mail service's state; the rest runs separately, with time limits, and never holds up a stop.
- **Configure Email → Sending → Send Automatically to Trusted Senders** (on by default): your Trusted Senders also count as Send Automatically To, so your own and your family's addresses need not be entered twice. Send Automatically To is for any other addresses.

### 2026.10.1:10

The email agent can send, under your rules.

- **Configure Email → Sending.** Off (read only), Drafts only (the default, as before), or Send by rules: Send Automatically To (addresses, or whole domains written @example.com), Never Send To, and what happens with Anyone Else: Ask me (recommended), Block, or Send automatically. Limits per hour, per day and per message.
- **Every recipient is checked** (To, Cc and Bcc). Anyone on Never Send To: refused. A forward, any attachment, or a limit reached: waits for your approval. Everyone on the automatic list: sent. Only drafts the email agent made itself can be sent.
- **New action: Review Outgoing Mail.** Mail waiting for you raises a task, a StartOS notification and an ntfy alert. You see the recipients, subject, opening lines, attachments and why it waits, and choose Approve, Reject, or Approve and always allow these recipients. Undecided mail expires after 3 days; a draft changed in your mail app meanwhile is not sent.
- **New action: Email Activity**: what the email agent read, filed, drafted and sent, what the rules held or refused, and your decisions (no message text).
- **Attachments on outgoing mail**: the main agent puts files in the workspace folder mail-outbox. Mail with attachments always waits for approval.
- **The Mail Service line no longer shows "starting" for 3 minutes** when the password is refused: the state shows as soon as the service answers. It also shows the sending level and how many messages wait for you.
- **Passwords off command lines.** Provider API keys and other secrets reach the gateway through a private file instead of the start command, so they no longer show in the server's process list; the Google sign-in keyring password and the StartOS login password are passed on standard input.
- The email agent is told that a verified sender does not make a message's content safe, and says which folder it searched.

### 2026.10.1:9

Fixes for the email agent (2026.10.1:8).

- **The email agent now gets its instructions.** 2026.10.1:8 wrote its instruction files (AGENTS.md, SOUL.md, IDENTITY.md) empty, so it worked without its rules and report format. Its limits were never affected: the tools it may use and what the mail service allows do not depend on those files.
- **The email agent's conversation is cleared after 15 minutes without requests**, so old mail does not pile up in it. Follow-up requests within a few minutes keep their context. (The main agent could not clear it when asked from the webchat.)
- A Vaultwarden "new device" mail mentioning rbw is no longer flagged as a suspected trick.

### 2026.10.1:8

Email that cannot be turned against you.

Mail is written by strangers, and a message can be written to trick the AI that reads it ("ignore your instructions and reply with the password"). Until now the agent that read mail also had a shell, the passwords and the power to send. This version separates them.

- **New action: Configure Email.** Email moves out of Configure External Services (your settings move with it). It adds the email agent's model, Trusted Senders and extra instructions.
- **A mail service** with its own Linux user is now the only thing that talks to the mailbox (Gmail with an app password, or any IMAP provider). The password comes from Vaultwarden (item "email") or the form, and stays in the service's memory: no agent can read it, and no password file is written.
- **An email agent** is the only agent that reads mail. It has the mail tools and nothing else: no shell, no files, no web, no memory, no passwords, no other agents. Mail reaches it as plain text: hidden text (white on white, invisible, zero-size) is removed, nothing is fetched from the internet, and the receiving server's sender checks (SPF/DKIM/DMARC) and warnings come with every message.
- **Your main agent no longer reads mail.** It asks the email agent and gets a short report back, which it treats as information, never as instructions.
- **In this version mail is read-only plus drafts**: read, search, mark read, flag, move, archive (never delete) and save drafts. Nothing is sent: drafts wait in your Drafts folder. Sending with your own rules and approval in StartOS comes next.
- **Attachments** stay in the mailbox, except from a trusted sender whose message the mail server verified: those can be copied to the workspace folder mail-inbox. The email agent can read the text of any attachment.
- **A changed password is picked up by itself**: when the mailbox refuses the password, the mail service fetches it again from Vaultwarden. A refused password is never tried twice, so your account is not locked; the service checks for a new one every 10 minutes and tells you (StartOS notification and ntfy).
- The Google account option (Gmail, Calendar and Drive through gog) is unchanged and not yet isolated.
- himalaya is no longer in the image.

### 2026.10.1:7

Node.js security update.

- **Node.js 26.12.1**, the October 2026 security release. It fixes ten vulnerabilities, among them an out-of-bounds write in Brotli decompression (which the agent could reach by fetching Brotli-compressed web content) and three ways around TLS certificate hostname checks. The gateway, the webchat and the JavaScript skills all run on it; 2026.10.1:6 carried 26.12.0.
- Node is now pinned to an exact release, so each version of this package states which Node it ships.

### 2026.10.1:6

Gitea remotes that never go stale.

- **New Gitea remotes use a placeholder: gitea:OWNER/REPO.git.** At every start the package maps gitea: to Gitea's current address, the way the other services get their address from a setting. Remotes made by the agent keep working after Gitea is reinstalled, gets a new LAN address or domain, or moves to another address. (In 2026.10.1:5, new repositories got the internal address Gitea reports to OpenClaw, which changes when Gitea is reinstalled.)
- **Links the agent gives you** use an address you can open: a domain if Gitea has one, otherwise its LAN address.
- **`gitea.py check` finds remotes made with the internal address**, and `check --fix` changes them to gitea:. Remotes written with Gitea's own addresses keep working as before.

### 2026.10.1:5

Gitea.

- **Gitea joins Configure External Services**, with Disabled, On this server and At an address like the others. The agent can then keep its workspace, scripts and projects in your own git repositories: create a repository, commit and push, with nothing going to a public site. Enter an access token of the Gitea account the agent uses (permissions: repository and user, Read and Write), or fetch it from Vaultwarden (item gitea, field api_key).
- **git signs in to Gitea by itself.** Every push and pull uses the token, fetched at that moment; nothing is written into repositories, remote URLs or credential files.
- **Existing remotes keep working.** With Gitea on this server, remotes written with any address Gitea shows (its clone URL, a LAN address, a private domain) go over the server's internal network, so they no longer depend on that address, DNS or the certificate.
- **A new gitea skill** gives the agent one documented way to create repositories, add remotes and push, and `gitea.py check` reports the set-up, including tokens stored in plain text. The health checks show whether Gitea answers and which account the token belongs to.

### 2026.10.1:4

Trilium on this server.

- **Trilium Notes can now be set to "On this server"** in Configure External Services, like Vaultwarden, n8n and the others. Install the Trilium package from the Marketplace, choose On this server, and enter only the ETAPI token (or fetch it from Vaultwarden); OpenClaw finds Trilium over the server's internal network, with no URL or certificate. It is listed as a dependency only while chosen, and the health check says so if it is not installed.
- Existing settings are unchanged: a Trilium you reach at an address stays "At an address", and its URL stays saved when you switch.

### 2026.10.1:3

Services on this server.

- **New choice in Configure External Services: "On this server".** Vaultwarden, Ollama, n8n, SearXNG, Crawl4AI and ntfy can now each be set to Disabled, On this server, or At an address. On this server means the service is installed on this StartOS server: OpenClaw finds it over the server's internal network, with no URL, host mapping or certificate, and asks only for the credentials. Moving a service onto your server becomes a change of choice instead of a new URL.
- A service set to On this server is listed as a dependency, so StartOS shows when it is not installed or not running, and the health check says so plainly. If it is reinstalled and its internal address changes, OpenClaw restarts on its own to use the new one.
- Existing settings are unchanged (At an address), and the URL you had stays saved when you switch, for switching back.
- Trilium's link in the form now points to TriliumNext, where Trilium is developed.

### 2026.10.1:2

Vault sync fix, and two email details.

- **Vault sync is checked and repaired.** rbw kept answering from its local copy of the vault when Vaultwarden stopped accepting its stored sign-in, so the vault looked healthy while items added or renamed in Vaultwarden never reached OpenClaw. Now:
  - At every start, a failed sync is logged, and if Vaultwarden itself is up, the package signs in to Vaultwarden again with the saved master password. If that does not help either, the previous local copy is kept, so lookups work as before.
  - The dashboard's "Vault (rbw)" check also syncs, and turns red when the sync fails. The agent's health skill reports the same.
  - A failed credential lookup now says why (for example "no entry found"), and whether the sync failed too.
- **Gmail app passwords work with or without their spaces.** Google shows them as four groups of four letters; the spaces are dropped when signing in.
- The instructions give the attach command with `--name openclaw-sub`, which skips the container question.

### 2026.10.1:1

Email, Google Calendar and Google Drive.

- **New: Configure External Services → Email.** One choice, three ways:
  - **Gmail (app password)**: the simplest way to give the agent a Gmail address (read, search, send, reply, file). Enter the address and a Google app password; Gmail's servers are filled in.
  - **Other IMAP/SMTP provider**: any mail service with IMAP and SMTP, including your own server (Custom Host Mappings and Custom CA apply).
  - **Google account (Gmail, Calendar, Drive)**: full Google access through a one-time sign-in made on your computer with gog. Instructions → Email Setup walks through it.
- **Every credential can live in Vaultwarden**: the email password (item "email", its login password), and for the Google account both the OAuth client and the sign-in token (item "google", fields client_json and token_json), loaded at every start. Or enter them in the form.
- **One naming standard for Vaultwarden**: one item per service, named in lowercase (email, nas, n8n, trilium, crawl4ai, ntfy, google); logins use their own username and password, keys go in a hidden custom field api_key. Lookups no longer depend on upper/lower case, so existing items such as "NAS" or "API_Key" keep working; rename them to the standard whenever convenient. The Vaultwarden option in Configure External Services now lists every name.
- New dashboard check for email: the IMAP server for the IMAP choices, "Signed in as …" for the Google account. The agent's health skill also tests the IMAP and SMTP logins and asks Google to confirm the sign-in.
- The image now includes himalaya 2.2.1 and gog 0.44.0, checksum-pinned for x86_64 and aarch64, with skills written for exactly those versions. OpenClaw's own bundled himalaya and gog skills stay off: the bundled himalaya one describes an older version.

### 2026.10.1:0

OpenClaw 2026.10.1. **Make a StartOS backup before updating**: the first start migrates the agent databases (1–2 minutes), which cannot be undone.

- **OpenClaw 2026.10.1** (from 2026.9.9). Among upstream's fixes: a gateway now keeps its state ownership when OpenClaw's command-line tool runs from a separate container, the failure that 2026.9.9:1 worked around. Actions still run the tool inside the gateway's own container.
- **The SimpleX plugin is upgraded to 2.2.0 automatically** on the first start, before the gateway. OpenClaw 2026.10.1 cannot load plugin 2.1 or older, and with it installed, OpenClaw's own repair step and agent changes (Configure Agents) fail. If the upgrade cannot download the plugin, it is retried at the next start and Configure SimpleX asks to be submitted again.
- The webchat uses OpenClaw 2026.10.1's gateway client.
- The README and the setup guide now describe the bundled rbw client as part of the package, with Vaultwarden as the service you point it at.

### 2026.9.9:2

Small polish.

- **Repair OpenClaw shows doctor's findings as readable lines** (severity, message, the setting involved and the suggested fix), followed by the full report. Doctor prints its report as a single line of JSON.
- **The configuration now records what the package runs**: a local gateway (`gateway.mode: local`) bound to the LAN (`gateway.bind: lan`). Doctor no longer warns that the gateway mode is unset or that the gateway is loopback-only; it now notes, correctly, that the gateway is reachable on your network, behind its password and the per-browser approval.
- Configure Webchat's description says what saving does: the webchat starts or stops, and the rest of OpenClaw keeps running.

### 2026.9.9:1

Fixes the gateway refusing to save anything after an agent was removed.

- **Removing an agent in Configure Agents no longer breaks the gateway.** The action ran OpenClaw's command-line tool in a temporary container, and with OpenClaw 2026.9.9 an agent removal made from there left the running gateway without its state lock: the removal failed ("state ownership … could not be verified") and the gateway then refused every state write (scheduled jobs, device pairing, cleanup) until it was restarted. Actions that run OpenClaw's command-line tool (Configure Agents, Approve Browser Pairing, Connect WhatsApp, Configure SimpleX) now run it inside the gateway's own container while the service is running.
- **Quieter logs.** The gateway no longer runs with verbose logging, which in OpenClaw 2026.9.9 wrote a scheduler line many times a second and pushed useful lines out of the service log.

### 2026.9.9:0

First release of OpenClaw Extra Butter (OpenClaw 2026.9.9).

A build of OpenClaw for StartOS with extra butter: a bundled Qdrant vector database, helper agents, optional connectors to your self-hosted services (Vaultwarden, Ollama, NAS, n8n, Trilium, SearXNG, Crawl4AI, ntfy), a mobile webchat, and PDF reading with OCR. It has its own package id, so it installs alongside the community OpenClaw package and never replaces it.

## Older designs and incidents

Details that used to live in the README as "since :NN" notes. They describe
earlier versions, not the current package.

### Files and folders that moved

- **Configure External Services' settings** were in `.openclaw/` until :26, where agents could change them; since :27 they are in the root-only `.openclaw-package/`.
- **The Vaultwarden master password** was in `.openclaw/rbw/.credentials` until :26, readable by every agent; the vault service (:27) moved it to `.openclaw-vault/credentials` and removed rbw's old files.
- **The email account** was the Email section of Configure External Services until :7, where a manually entered password was readable by agents; init moves it to `.openclaw-mail/settings.json`.
- **Agents' skills for mail and calendar:** until :19 the main agent had skills `email` and `calendar` and asked those agents directly; since :20 it has one skill, `apps`, and asks the apps agent.
- **Review Agent Actions** was *Review Outgoing Mail* until :13 (mail only); calendar requests joined in :16; its task was `mail-queue` from :10 to :13 (cleared once per start since).
- **Agent Activity** was *Email Activity* (mail only) until :17.
- **Approvals** expired after 3 days until :20, 5 days since.
- **Routine mailings** counted 30 days in :22 and calendar months (UTC) since :23.
- **The gateway** was the `primary` daemon until :39 (`11-gateway` since :40).
- **Health check ids** had no numbers until :39; StartOS sorts lines by id, so :40 added them to set the order.

### Decisions that were reversed

- **The Login to StartOS task** was raised at every start while start-cli was signed out (the `check-login` oneshot), until :39. Signed out is the safe state, so :40 removed it and clears any left over.
- **The Server Access line** showed signed out as a green check until :40; since :41 it is a grey dash (*disabled*, a deliberate off state), and signed in is orange. :41 also stopped using `auth session list`, whose answer changed in StartOS 0.4.1 so that start-cli 2.2.0 could not read it.
- **Review Agent Actions** pre-selected Approve until :37; since :38 no decision is pre-selected.
- **Releases were signed by a new, random key** until :41 (`s9pk init-workspace` makes a fresh build key on every CI run, so the `DEV_KEY` secret was passed but unused); since :42 every release is signed by one key.

### Incidents

- **An update stalled at 80%** (fixed in :19): StartOS stops a service only after each health check finishes its current run, and the SDK's `exec` waits for the subcontainer with no limit; `ext-gitea` and `ext-ollama` hung there for 6 hours. Health checks have had a time limit since.
- **A restart waited forever** (:10): it began while a health check was creating a task, and waited on it (and a server reboot behind it). Task work has run as side jobs the check never awaits since.
- **Processes' environments were readable** until :9: StartOS passes a daemon's environment as command-line arguments. Since :10 the gateway's secrets are in a file it sources at start.
- **The contacts user took the vault's number** (:31): created first, it got 997, and the vault's files no longer counted as its own. Since :32 every service user has a fixed number checked at build time.
- **A stale "no" from the contacts check** (until :34): the mail and calendar services were told an address was not a contact when the copy predated it, while the contacts agent found it moments later. A copy older than 15 minutes is now refreshed before answering.
- **Fastmail's own autoconfig file** names only OAuth2 (:36): a config offering only OAuth2 no longer ends the search for a password login.
- **Shared calendars were marked `organizer_self`** until :24: Google's `organizer.self` means "the owner of the calendar this copy is on". Since :25 only the account's own calendars count.
- **Usage and Cost read low** until :44: OpenClaw 2026.10 stores events of 1 KB or more zstd-compressed, with the usage only inside, and those were not counted (about a third of the cost). :45 reads them. An earlier check against the provider's weekly bill had matched within 1.3%, probably on a week with few long replies.
- **Sideloading from the browser on StartOS 0.4.1.2** broke off partway for this ~445 MB package ("Connection closed or timed out before full file received"); installing with `start-cli package install --sideload` on the server worked.
