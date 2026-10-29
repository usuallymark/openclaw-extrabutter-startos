import { actions } from '../actions'
import { restoreInit } from '../backups'
import { dependencies } from '../dependencies'
import { versionGraph } from '../versions'
import { setInterfaces } from '../interfaces'
import { sdk } from '../sdk'
import { initializeService } from './initializeService'
import { initEmailSettings } from '../mailService'
import { initCalendarSettings } from '../calendarService'
import { installTasks } from './installTasks'
import { taskConfigureApi } from './taskConfigureApi'
import { taskSetPassword } from './taskSetPassword'

export const init = sdk.setupInit(
  restoreInit,
  versionGraph,
  setInterfaces,
  dependencies,
  actions,
  installTasks,
  taskConfigureApi,
  taskSetPassword,
  initializeService,
  initEmailSettings,
  initCalendarSettings,
)

export const uninit = sdk.setupUninit(versionGraph)
