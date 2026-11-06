import { i18n } from '../i18n'

// The headers the Actions list is grouped under (since 2026.10.1:38). Every
// action has one, so none is left in an ungrouped list above the others.
// StartOS shows the groups in the order their first action is added in
// actions/index.ts, which follows this list.

/** What the owner opens day to day: decisions, logs and cost. */
export const GROUP_DAILY = 'Daily'
/** The isolated services and the agent between them and the main agent. */
export const GROUP_APPS = 'Email, Calendar, Contacts'
/** Set up once: sign-in, models, agents, the other services on the server. */
export const GROUP_SETUP = 'Setup'
/** Ways to talk to the assistant. */
export const GROUP_CHANNELS = i18n('Channels')
/** Server access and repairs, rarely needed. */
export const GROUP_MAINTENANCE = 'Maintenance'
