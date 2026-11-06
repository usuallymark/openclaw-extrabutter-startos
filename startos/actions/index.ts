import { sdk } from '../sdk'
import { approveDevices } from './approveDevices'
import { configureAgents } from './configureAgents'
import { configureApiCredentials } from './configureApiCredentials'
import { configureEmail } from './configureEmail'
import { lookUpMailServers } from './lookUpMailServers'
import { agentActivity } from './agentActivity'
import { spendingAlert, usageAndCost } from './usageAndCost'
import { configureCalendar } from './configureCalendar'
import { lookUpCalendarServer } from './lookUpCalendarServer'
import { configureContacts } from './configureContacts'
import { configureAppsAgent } from './configureAppsAgent'
import { reviewAgentActions } from './reviewAgentActions'
import { configureExternalServices } from './configureExternalServices'
import { configureWebchat } from './configureWebchat'
import { connectTelegram } from './connectTelegram'
import { connectWhatsapp } from './connectWhatsapp'
import { configureSimplex } from './configureSimplex'
// import { configureSynapse } from './configureSynapse'
import { loginToOs } from './loginToOs'
import { repairOpenclaw } from './repairOpenclaw'
import { revokeStartOsAccess } from './revokeStartOsAccess'
import { setPassword } from './setPassword'

export const actions = sdk.Actions.of()
  // Grouped (actions/groups.ts); StartOS shows the groups in this order.
  // Daily
  .addAction(reviewAgentActions)
  .addAction(agentActivity)
  .addAction(usageAndCost)
  .addAction(spendingAlert)
  // Email, Calendar, Contacts
  .addAction(configureEmail)
  .addAction(lookUpMailServers)
  .addAction(configureCalendar)
  .addAction(lookUpCalendarServer)
  .addAction(configureContacts)
  .addAction(configureAppsAgent)
  // Setup
  .addAction(setPassword)
  .addAction(configureApiCredentials)
  .addAction(configureAgents)
  .addAction(configureExternalServices)
  .addAction(approveDevices)
  // Channels
  .addAction(configureWebchat)
  .addAction(connectTelegram)
  .addAction(connectWhatsapp)
  .addAction(configureSimplex)
  // .addAction(configureSynapse)
  // Maintenance
  .addAction(loginToOs)
  .addAction(repairOpenclaw)
  .addAction(revokeStartOsAccess)
