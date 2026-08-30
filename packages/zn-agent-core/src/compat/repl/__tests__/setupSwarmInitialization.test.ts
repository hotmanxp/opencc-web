// @ts-nocheck
import { setupSwarmInitialization } from '../setup/setupSwarmInitialization.js'

describe('setupSwarmInitialization', () => {
  it('createTeammate returns id and fires callback', () => {
    let createdId: string | null = null
    const handle = setupSwarmInitialization({
      sessionId: 'lead-1',
      teamName: 'team-a',
      onTeammateCreated: id => { createdId = id },
    })
    const id = handle.createTeammate('researcher', 'analyst')
    expect(id).toBeTruthy()
    expect(createdId).toBe(id)
    handle.teardown()
  })

  it('teardown stops accepting new teammates', () => {
    const handle = setupSwarmInitialization({
      sessionId: 'lead-2',
      onTeammateCreated: () => {},
    })
    handle.teardown()
    expect(() => handle.createTeammate('a', 'b')).toThrow(/disposed/)
  })
})
