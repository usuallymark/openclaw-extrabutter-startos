// Sent verbatim as the heartbeat turn's user message; scratch is appended when set.
export const HEARTBEAT_PROMPT = `Daily heartbeat. Run exactly this one command:

refresh-snapshot --reason heartbeat

It rewrites the Server State Snapshot section of MEMORY.md by itself. Do nothing else in this turn: do not edit MEMORY.md or any other file yourself, do not write, save or run any other script or command, and do not run git. If the command fails, do not try to work around it.

If a heartbeat monitor scratch context is attached below, follow it after the command. When done, reply NO_REPLY.`
