import { sdk } from '../sdk'
import { approveDevices } from './approveDevices'
import { configureAgents } from './configureAgents'
import { configureApiCredentials } from './configureApiCredentials'
import { configureEmail } from './configureEmail'
import { agentActivity } from './agentActivity'
import { configureCalendar } from './configureCalendar'
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
  .addAction(setPassword)
  .addAction(configureApiCredentials)
  .addAction(configureAgents)
  .addAction(configureEmail)
  .addAction(reviewAgentActions)
  .addAction(agentActivity)
  .addAction(configureCalendar)
  .addAction(configureAppsAgent)
  .addAction(configureExternalServices)
  .addAction(configureWebchat)
  .addAction(connectTelegram)
  .addAction(connectWhatsapp)
  .addAction(configureSimplex)
  // .addAction(configureSynapse)
  .addAction(loginToOs)
  .addAction(approveDevices)
  .addAction(repairOpenclaw)
  .addAction(revokeStartOsAccess)
