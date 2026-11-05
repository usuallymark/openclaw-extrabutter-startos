import { actions } from '../actions'
import { restoreInit } from '../backups'
import { dependencies } from '../dependencies'
import { versionGraph } from '../versions'
import { setInterfaces } from '../interfaces'
import { sdk } from '../sdk'
import { initializeService } from './initializeService'
import { initEmailSettings } from '../mailService'
import { initCalendarSettings } from '../calendarService'
import { initContactsSettings } from '../contactsService'
import { initPackageSettings } from '../vaultService'
import { installTasks } from './installTasks'
import { taskConfigureApi } from './taskConfigureApi'
import { taskSetPassword } from './taskSetPassword'

export const init = sdk.setupInit(
  restoreInit,
  versionGraph,
  // Before anything reads Configure External Services' file (it moves).
  initPackageSettings,
  setInterfaces,
  dependencies,
  actions,
  installTasks,
  taskConfigureApi,
  taskSetPassword,
  initializeService,
  initEmailSettings,
  initCalendarSettings,
  initContactsSettings,
)

export const uninit = sdk.setupUninit(versionGraph)
