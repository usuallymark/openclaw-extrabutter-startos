# Privacy

OpenClaw Extra Butter is a StartOS package that each owner installs and
runs on their own server. There is no hosted service: the developer of
this package receives no data from anyone's installation.

## The Google app

To use Google Calendar, each owner creates their own Google Cloud app (an
OAuth client in their own Google Cloud project) and signs in with their
own Google account. That app is used only by the owner's own server, for
the owner's own household.

- **What it asks for:** permission to see and download the calendars the
  signed-in account can access (`calendar.readonly`), and the account's
  email address. It cannot create, change or delete anything.
- **What happens to the data:** calendar events are read by the owner's own
  server when the owner's assistant is asked about the calendar, and shown
  to the owner. Nothing is sold, shared or sent to any third party, and
  nothing is used to train models or for advertising. The owner's chosen AI
  provider processes the parts of events the assistant reads, under the
  owner's own account with that provider.
- **Where it is stored:** the sign-in is stored on the owner's server
  only, in a folder the assistant's agents cannot read (or in the owner's
  own Vaultwarden). The calendar service keeps an activity log without
  event text, on the same server.
- **How to stop it:** remove the app's access at
  <https://myaccount.google.com/connections>, or set Configure Calendar to
  Off. Uninstalling the package removes everything it stored.

The app's use of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## Contact

Questions about this package: open an issue at
<https://github.com/usuallymark/openclaw-extrabutter-startos/issues>.
