import { delay } from 'nanodelay'

import { TestClient, LoguxUndoError } from '../index.js'

interface NameAction {
  type: 'name'
  userId: string
}

async function catchError (cb: () => Promise<any>) {
  let error: LoguxUndoError | undefined
  try {
    await cb()
  } catch (e) {
    error = e
  }
  if (!error) throw new Error('Error was no raised')
  return error
}

it('sets node ID', () => {
  let client = new TestClient('10')
  expect(client.nodeId).toEqual('10:2:2')
})

it('collects actions', async () => {
  let client1 = new TestClient('10')
  let client2 = new TestClient('20', { server: client1.server })
  await Promise.all([client1.connect(), client2.connect()])

  await client1.sync({ type: 'A' })
  let action1 = await client1.sent(async () => {
    await client1.log.add({ type: 'local' })
    await client1.sync({ type: 'B' })
    await client2.sync({ type: 'C' })
  })
  expect(action1).toEqual([{ type: 'B' }])
})

it('keeps actions by request', async () => {
  let client = new TestClient('10')
  await client.connect()

  await client.sync({ type: 'A' })
  expect(client.log.actions()).toEqual([])
  expect(client.server.log.actions()).toEqual([])

  client.keepActions()
  await client.sync({ type: 'B' })
  expect(client.log.actions()).toEqual([
    { type: 'B' },
    { type: 'logux/processed', id: '3 10:2:2 0' }
  ])
  expect(client.server.log.actions()).toEqual([])

  client.server.keepActions()
  await client.sync({ type: 'C' })
  expect(client.log.actions()).toEqual([
    { type: 'B' },
    { type: 'logux/processed', id: '3 10:2:2 0' },
    { type: 'C' },
    { type: 'logux/processed', id: '5 10:2:2 0' }
  ])
  expect(client.server.log.actions()).toEqual([
    { type: 'C' },
    { type: 'logux/processed', id: '5 10:2:2 0' }
  ])
})

it('connects, sends, and processes actions', async () => {
  let client = new TestClient('10')
  client.keepActions()
  client.server.keepActions()

  await client.log.add({ type: 'local' })
  await client.log.add({ type: 'offline1' }, { sync: true })
  expect(client.log.actions()).toEqual([
    { type: 'local' },
    { type: 'offline1' }
  ])
  expect(client.server.log.actions()).toEqual([])

  await client.connect()
  expect(client.server.log.actions()).toEqual([
    { type: 'offline1' },
    { type: 'logux/processed', id: '2 10:2:2 0' }
  ])

  await delay(10)
  expect(client.log.actions()).toEqual([
    { type: 'local' },
    { type: 'offline1' },
    { type: 'logux/processed', id: '2 10:2:2 0' }
  ])
  expect(client.log.entries()[2][1].nodes).toBeUndefined()

  client.disconnect()

  await client.server.log.add({ type: 'offline2' }, { nodes: [client.nodeId] })
  expect(client.server.log.actions()).toEqual([
    { type: 'offline1' },
    { type: 'logux/processed', id: '2 10:2:2 0' },
    { type: 'offline2' }
  ])

  await delay(10)
  expect(client.log.actions()).toHaveLength(3)

  await client.connect()
  await delay(10)
  expect(client.log.actions()).toEqual([
    { type: 'local' },
    { type: 'offline1' },
    { type: 'logux/processed', id: '2 10:2:2 0' },
    { type: 'offline2' }
  ])
})

it('supports channels', async () => {
  let client = new TestClient('10')
  client.keepActions()

  client.server.onChannel('users/1', { type: 'name', userId: '1' })
  client.server.onChannel('users/1', { type: 'name', userId: '1', name: 'A' })

  client.server.onChannel('users/2', [
    { type: 'name', userId: '2', name: 'B1' },
    { type: 'name', userId: '2', name: 'B2' }
  ])

  client.server.onChannel('users/3', [
    [{ type: 'name', userId: '3', name: 'C' }, { time: 1 }]
  ])

  await client.connect()
  await client.sync(
    { type: 'logux/subscribe', channel: 'users/1' },
    { sync: true }
  )
  await client.sync(
    { type: 'logux/subscribe', channel: 'users/2' },
    { sync: true }
  )
  await client.sync(
    { type: 'logux/subscribe', channel: 'users/3' },
    { sync: true }
  )

  expect(client.subscribed('users/1')).toBe(true)
  expect(client.log.actions()).toEqual([
    { type: 'logux/subscribe', channel: 'users/1' },
    { type: 'name', userId: '3', name: 'C' },
    { type: 'name', userId: '1', name: 'A' },
    { type: 'logux/processed', id: '1 10:2:2 0' },
    { type: 'logux/subscribe', channel: 'users/2' },
    { type: 'name', userId: '2', name: 'B1' },
    { type: 'name', userId: '2', name: 'B2' },
    { type: 'logux/processed', id: '4 10:2:2 0' },
    { type: 'logux/subscribe', channel: 'users/3' },
    { type: 'logux/processed', id: '8 10:2:2 0' }
  ])

  await client.sync(
    { type: 'logux/unsubscribe', channel: 'users/1' },
    { sync: true }
  )
  expect(client.subscribed('users/1')).toBe(false)
  expect(client.subscribed('users/2')).toBe(true)

  client.disconnect()
  await delay(1)
  expect(client.subscribed('users/2')).toBe(false)
})

it('supports undo', async () => {
  let client = new TestClient('10')
  await client.connect()

  client.server.undoNext()
  let error1 = await catchError(() => client.sync({ type: 'test' }))
  expect(error1.message).toEqual('Server undid Logux action because of error')

  await client.sync({ type: 'test' })

  client.server.undoNext('test')
  client.server.undoNext('test', { key: 1 })

  let error2 = await catchError(() => client.sync({ type: 'test' }))
  expect(error2.message).toEqual('Server undid Logux action because of test')

  let error3 = await catchError(() => client.sync({ type: 'test' }))
  expect(error3.message).toEqual('Server undid Logux action because of test')
  expect(error3.action.key).toEqual(1)
})

it('supports undo for specific action', async () => {
  let client = new TestClient('10')
  await client.connect()

  client.server.undoAction({ type: 'B' })
  await client.sync({ type: 'A' })
  let error = await catchError(() => client.sync({ type: 'B' }))
  expect(error.message).toEqual('Server undid Logux action because of error')
})

it('supports multiple clients with same server', async () => {
  let client1 = new TestClient('10')
  let client2 = new TestClient('20', { server: client1.server })
  client1.keepActions()
  client2.keepActions()

  await Promise.all([client1.connect(), client2.connect()])

  client1.server.onChannel('users/1', { type: 'name', userId: '1', name: 'A' })
  client1.server.resend<NameAction>('name', action => `users/${action.userId}`)

  await client1.sync({ type: 'default' })
  await delay(1)
  expect(client2.log.actions()).toEqual([{ type: 'default' }])

  await client2.sync({ type: 'logux/subscribe', channel: 'users/1' })
  expect(client1.log.actions()).toEqual([
    { type: 'default' },
    { type: 'logux/processed', id: '1 10:2:2 0' }
  ])
  expect(client2.log.actions()).toEqual([
    { type: 'default' },
    { type: 'logux/subscribe', channel: 'users/1' },
    { type: 'name', userId: '1', name: 'A' },
    { type: 'logux/processed', id: '3 20:3:3 0' }
  ])

  await client1.sync({ type: 'name', userId: '1', name: 'B' })
  await delay(10)
  expect(client1.log.actions()).toEqual([
    { type: 'default' },
    { type: 'logux/processed', id: '1 10:2:2 0' },
    { type: 'name', userId: '1', name: 'B' },
    { type: 'logux/processed', id: '6 10:2:2 0' }
  ])
  expect(client2.log.actions()).toEqual([
    { type: 'default' },
    { type: 'logux/subscribe', channel: 'users/1' },
    { type: 'name', userId: '1', name: 'A' },
    { type: 'logux/processed', id: '3 20:3:3 0' },
    { type: 'name', userId: '1', name: 'B' }
  ])
  expect(client2.log.entries()[3][1].channels).toBeUndefined()

  await client2.sync({ type: 'logux/unsubscribe', channel: 'users/1' })
  await client1.sync({ type: 'name', userId: '1', name: 'C' })

  client1.server.undoNext()
  try {
    await client1.sync({ type: 'name', userId: '1', name: 'D' })
  } catch {}

  expect(client1.log.actions()).toEqual([
    { type: 'default' },
    { type: 'logux/processed', id: '1 10:2:2 0' },
    { type: 'name', userId: '1', name: 'B' },
    { type: 'logux/processed', id: '6 10:2:2 0' },
    { type: 'name', userId: '1', name: 'C' },
    { type: 'logux/processed', id: '10 10:2:2 0' },
    { type: 'name', userId: '1', name: 'D' },
    {
      type: 'logux/undo',
      id: '12 10:2:2 0',
      reason: 'error',
      action: { type: 'name', userId: '1', name: 'D' }
    }
  ])
  expect(client2.log.actions()).toEqual([
    { type: 'default' },
    { type: 'logux/subscribe', channel: 'users/1' },
    { type: 'name', userId: '1', name: 'A' },
    { type: 'logux/processed', id: '3 20:3:3 0' },
    { type: 'name', userId: '1', name: 'B' },
    { type: 'logux/unsubscribe', channel: 'users/1' },
    { type: 'logux/processed', id: '8 20:3:3 0' }
  ])
})

it('supports subprotocols', async () => {
  let client1 = new TestClient('10')
  let client2 = new TestClient('20', {
    server: client1.server,
    subprotocol: '1.0.1'
  })
  client1.keepActions()
  client2.keepActions()
  await Promise.all([client1.connect(), client2.connect()])

  await client1.sync({ type: 'client1' })
  await client2.sync({ type: 'client2' })
  await delay(1)

  expect(client1.log.actions()).toEqual([
    { type: 'client1' },
    { type: 'logux/processed', id: '1 10:2:2 0' },
    { type: 'client2' }
  ])
  expect(client1.log.entries()[2][1].subprotocol).toEqual('1.0.1')

  expect(client2.log.actions()).toEqual([
    { type: 'client1' },
    { type: 'client2' },
    { type: 'logux/processed', id: '3 20:3:3 0' }
  ])
  expect(client2.log.entries()[0][1].subprotocol).toEqual('0.0.0')
})

it('freezes processing', async () => {
  let client = new TestClient('10')
  client.keepActions()
  await client.connect()
  await client.server.freezeProcessing(async () => {
    await client.log.add({ type: 'test' }, { sync: true })
    await delay(10)
    expect(client.log.actions()).toEqual([{ type: 'test' }])
  })
  expect(client.log.actions()).toEqual([
    { type: 'test' },
    { type: 'logux/processed', id: '1 10:2:2 0' }
  ])
})
