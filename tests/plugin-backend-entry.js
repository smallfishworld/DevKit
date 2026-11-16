const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { fork } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { PluginService } = require('../src/main/services/plugins')
const { PluginStore, parseManifest, safePackagePath } = require('../src/main/services/plugins/store')
const { validateSchema, applyDefaults } = require('../src/main/services/plugins/schema')

const fixtureManifest = {
  id: 'test.serial-fixture', name: 'Fixture', version: '1.0.0', apiVersion: 1, entry: 'index.cjs',
  configSchema: { type: 'object', properties: { match: { type: 'string', default: 'PING' }, delay: { type: 'integer', minimum: 0, maximum: 2000, default: 0 } }, required: ['match'], additionalProperties: false },
  actions: [{ id: 'ping', label: 'Ping' }, { id: 'wait', label: 'Wait' }, { id: 'secret', label: 'Secret' }, { id: 'crash', label: 'Crash' }],
  autoRespond: true, capabilities: ['serial.read','serial.write']
}
const pluginCode = `exports.activate = async (ctx) => ({
  async run(action) {
    if (action === 'ping') return await ctx.serial.exchange('PING', { match: 'PONG', timeoutMs: 2000 })
    if (action === 'wait') return await ctx.serial.exchange('WAIT', { match: 'never', timeoutMs: 10000 })
    if (action === 'secret') { await ctx.serial.write('sensitive-token', { secret: true }); ctx.log('info','sent sensitive-token'); return { ok:true } }
    if (action === 'crash') process.exit(9)
  },
  async onData(event) {
    if (ctx.config.delay) await new Promise(r=>setTimeout(r,ctx.config.delay))
    if (event.text === 'TRIGGER') await ctx.serial.write('AUTO')
  },
  async dispose() { ctx.log('info','disposed') }
})`

function makeBridge() {
  const listeners = new Map()
  const sessions = new Map([['p1', { panelId:'p1', connectionId:'c1', path:'MOCK1', encoding:'utf8' }],['p2', { panelId:'p2', connectionId:'c2', path:'MOCK2', encoding:'utf8' }]])
  const owners = new Map()
  const writes = []
  const subscriptions = []
  let sequence = 0
  function emit(panelId,event) { for (const listener of [...(listeners.get(panelId) ?? [])]) listener(event) }
  function data(panelId, text) {
    const session=sessions.get(panelId)
    emit(panelId,{ type:'data',connectionId:session.connectionId,bytes:[...Buffer.from(text)],text,receivedAt:Date.now(),sequence:++sequence })
  }
  return {
    writes, owners, sessions, listeners, subscriptions, data,
    close(panelId) { const session=sessions.get(panelId); sessions.delete(panelId); emit(panelId,{type:'closed',connectionId:session.connectionId,reason:'disconnected'}) },
    describe: panelId => sessions.get(panelId),
    subscribe(panelId, listener, owner) {
      subscriptions.push({panelId,owner})
      if(!listeners.has(panelId)) listeners.set(panelId,new Set())
      listeners.get(panelId).add(listener)
      return ()=>listeners.get(panelId)?.delete(listener)
    },
    async acquire(panelId, owner, signal) {
      assert.ok(!owners.has(panelId), 'port is exclusively owned')
      owners.set(panelId,owner)
      let released=false
      const release=()=>{ if(released)return; released=true; owners.delete(panelId); signal.removeEventListener('abort',release) }
      signal.addEventListener('abort',release,{once:true})
      return {
        connectionId:sessions.get(panelId).connectionId,
        async write(bytes,options) {
          signal.throwIfAborted()
          assert.equal(owners.get(panelId),owner)
          const text=Buffer.from(bytes).toString('utf8')
          writes.push({ panelId,text,secret:options?.secret })
          // Deliberately synchronous response: waiting must be armed before writing.
          if(text==='PING') data(panelId,'PONG')
        },
        release
      }
    }
  }
}
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms))
async function until(fn,label) { for(let i=0;i<100;i++){ if(await fn()) return; await delay(20) } throw new Error('timed out: '+label) }
async function main() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'devkit-plugins-'))
  const source=path.join(root,'source')
  await fs.mkdir(source)
  await fs.writeFile(path.join(source,'manifest.json'),JSON.stringify(fixtureManifest))
  await fs.writeFile(path.join(source,'index.cjs'),pluginCode)
  const ownedProcesses=[]
  let ownedService
  try {
    assert.equal(parseManifest(fixtureManifest).id,fixtureManifest.id)
    assert.throws(()=>parseManifest({...fixtureManifest,apiVersion:2}),/不兼容/)
    assert.throws(()=>parseManifest({...fixtureManifest,version:'latest'}),/语义版本/)
    assert.throws(()=>safePackagePath(root,'../outside.cjs'),/路径无效/)
    assert.throws(()=>validateSchema({type:'object',oneOf:[]}),/不支持/)
    assert.throws(()=>applyDefaults({delay:-1},fixtureManifest.configSchema),/最小值/)
    assert.deepEqual(applyDefaults({},fixtureManifest.configSchema),{match:'PING',delay:0})
    const store=new PluginStore(path.join(root,'store-check'))
    const installed=await store.install(source,new Set())
    assert.equal(installed.id,fixtureManifest.id)
    await assert.rejects(store.install(source,new Set([fixtureManifest.id])),/不能覆盖/)
    const jsonBundle=path.join(root,'bundle.json')
    await fs.writeFile(jsonBundle,JSON.stringify({manifest:{...fixtureManifest,id:'test.json-bundle'},files:{'index.cjs':pluginCode}}))
    assert.equal((await store.install(jsonBundle,new Set())).id,'test.json-bundle')
    await fs.writeFile(jsonBundle,JSON.stringify({manifest:fixtureManifest,files:{'../escape.js':'bad'}}))
    await assert.rejects(store.install(jsonBundle,new Set()),/路径无效/)
    const bridge=makeBridge()
    const processes=ownedProcesses
    const events=[]
    const service=new PluginService(bridge,[],{
      userData:path.join(root,'runtime'),
      hostPath:process.env.DEVKIT_PLUGIN_TEST_HOST,
      hostFactory(script) {
        const child=fork(script,[],{stdio:['ignore','ignore','inherit','ipc']})
        processes.push(child)
        const wrapper=new EventEmitter()
        child.on('message',message=>wrapper.emit('message',message))
        child.on('exit',(code,signal)=>wrapper.emit('exit',code,signal))
        child.on('error',error=>wrapper.emit('error',error))
        wrapper.postMessage=message=>child.send(message)
        wrapper.kill=()=>child.kill()
        return wrapper
      },
      emit:(panelId,type,payload)=>events.push({panelId,type,payload})
    })
    ownedService=service
    const api=(action,payload,panel='p1')=>service.invoke(panel,action,payload)
    assert.equal((await api('install',{path:source})).ok,true)
    let saved=await api('instance:save',{instance:{pluginId:fixtureManifest.id,label:'A',config:{},enabled:true,autoEnabled:true}})
    assert.equal(saved.ok,true)
    const id=saved.instance.id
    assert.deepEqual(saved.instance.config,{match:'PING',delay:0})
    assert.equal((await api('bind',{instanceId:id})).ok,true)
    assert.equal((await api('bind',{instanceId:id})).ok,true,'idempotent bind')
    assert.equal((await api('bind',{instanceId:id},'p2')).ok,false,'cannot steal another session')
    let result=await api('run',{instanceId:id,actionId:'ping'})
    assert.equal(result.ok,true)
    assert.equal(result.result.text,'PONG','synchronous response preserved')
    assert.ok(bridge.subscriptions.every(entry=>entry.owner==='plugin:'+id),'raw subscriptions identify the lease owner')
    assert.equal(bridge.owners.size,0,'lease released after command')
    bridge.data('p1','TRIGGER')
    await until(()=>bridge.writes.some(item=>item.text==='AUTO'),'auto response')
    await until(()=>bridge.owners.size===0,'auto lease release')
    result=await api('run',{instanceId:id,actionId:'secret'})
    assert.equal(result.ok,true)
    const logs=(await api('status')).logs
    assert.ok(logs.some(item=>item.message==='sent [口令已隐藏]'))
    assert.ok(!logs.some(item=>item.message.includes('sensitive-token')))
    const waiting=api('run',{instanceId:id,actionId:'wait'})
    await until(()=>bridge.writes.some(item=>item.text==='WAIT'),'wait started')
    assert.equal((await api('stop',{instanceId:id})).ok,true)
    assert.equal((await waiting).ok,false,'stop cancels pending exchange')
    assert.equal(bridge.owners.size,0)
    assert.equal(bridge.listeners.get('p1').size,0,'all subscribers disposed')
    assert.equal((await api('bind',{instanceId:id})).ok,true)
    const disablingWait=api('run',{instanceId:id,actionId:'wait'})
    await until(()=>bridge.writes.filter(item=>item.text==='WAIT').length===2,'second wait started')
    const disabled=await api('instance:save',{instance:{...saved.instance,enabled:false}})
    assert.equal(disabled.ok,true,'disable may interrupt running action')
    assert.equal((await disablingWait).ok,false)
    assert.equal(bridge.owners.size,0)
    assert.equal((await api('bind',{instanceId:id})).ok,false,'disabled instances cannot bind')
    assert.equal((await api('instance:save',{instance:{...saved.instance,enabled:true}})).ok,true)
    assert.equal((await api('bind',{instanceId:id})).ok,true)
    const crashed=await api('run',{instanceId:id,actionId:'crash'})
    assert.equal(crashed.ok,false,'host crash reaches caller')
    assert.equal(bridge.owners.size,0)
    assert.equal((await api('status')).statuses.find(s=>s.instanceId===id).state,'error')
    assert.equal((await api('bind',{instanceId:id})).ok,true)
    bridge.close('p1')
    await until(async()=>!(await api('status')).statuses.find(s=>s.instanceId===id).bound,'disconnect cleanup')
    assert.equal(bridge.owners.size,0)
    bridge.sessions.set('p1',{panelId:'p1',connectionId:'c-new',path:'MOCK1',encoding:'utf8'})
    assert.equal((await api('bind',{instanceId:id})).ok,true)
    const status=(await api('status')).statuses.find(s=>s.instanceId===id)
    assert.equal(status.connectionId,'c-new','reconnect has fresh identity')
    assert.equal((await api('instance:save',{instance:{...saved.instance,config:{match:'PING',delay:1000}}})).ok,true)
    for(let i=0;i<130;i++)bridge.data('p1','small')
    await until(async()=>(await api('status')).statuses.find(s=>s.instanceId===id).state==='error','bounded auto queue')
    assert.equal(bridge.owners.size,0,'queue failure releases control')
    await service.dispose('*')
    await until(()=>processes.every(child=>child.exitCode!==null||child.signalCode!==null),'children exit')
    assert.equal(bridge.owners.size,0)
    // Saved instances survive restart; binding and auto execution do not.
    const reloaded=new PluginService(bridge,[],{userData:path.join(root,'runtime'),emit:()=>{}})
    assert.equal((await reloaded.invoke('p1','instance:list')).instances.length,1)
    assert.equal((await reloaded.invoke('p1','status')).statuses.length,0)
    assert.equal((await reloaded.invoke('p1','remove',{pluginId:fixtureManifest.id})).ok,true)
    assert.equal((await reloaded.invoke('p1','instance:list')).instances[0].id,id,'uninstall retains configuration identity')
    assert.equal((await reloaded.invoke('p1','list')).plugins.length,0)
    const migratedRoot=path.join(root,'migration')
    await fs.mkdir(migratedRoot)
    await fs.writeFile(path.join(migratedRoot,'device-actions.json'),'{malformed')
    const builtin={manifest:{...fixtureManifest,id:'devkit.oa-debug'},activate:()=>({})}
    const migration=new PluginService(bridge,[builtin],{userData:migratedRoot,emit:()=>{}})
    assert.equal((await migration.invoke('p1','list')).ok,true,'bad OA config cannot block unrelated plugins')
    assert.ok((await migration.invoke('p1','status')).logs.some(entry=>entry.level==='warn'))
    await fs.writeFile(path.join(migratedRoot,'device-actions.json'),JSON.stringify({profiles:[{id:'a'.repeat(64),label:'Legacy'}]}))
    const legacyInstances=(await migration.invoke('p1','instance:list')).instances
    assert.equal(legacyInstances.length,1,'fixed legacy file retries migration')
    assert.equal(legacyInstances[0].id.length,71)
    const migrationReload=new PluginService(bridge,[builtin],{userData:migratedRoot,emit:()=>{}})
    assert.equal((await migrationReload.invoke('p1','instance:list')).instances.length,1,'71-character legacy identity reloads')
    const stateStore=new PluginStore(path.join(root,'size-limit'))
    await stateStore.writeState([],false)
    await assert.rejects(stateStore.writeState([{...saved.instance,config:{huge:'x'.repeat(2*1024*1024)}}],false),/2MiB/)
    assert.deepEqual((await stateStore.readState()).instances,[],'oversized write leaves old state intact')
    const contexts=[]
    const generationPlugin={
      manifest:{...fixtureManifest,id:'test.generation',actions:[],autoRespond:false,configSchema:{type:'object',additionalProperties:false}},
      activate(ctx){contexts.push(ctx);return {dispose(){}}}
    }
    const generation=new PluginService(bridge,[generationPlugin],{userData:path.join(root,'generation'),emit:()=>{}})
    const ga=(action,payload)=>generation.invoke('p1',action,payload)
    const generationInstance=(await ga('instance:save',{instance:{pluginId:'test.generation',label:'Generation',config:{}}})).instance
    assert.equal((await ga('bind',{instanceId:generationInstance.id})).ok,true)
    await ga('stop',{instanceId:generationInstance.id})
    assert.equal((await ga('bind',{instanceId:generationInstance.id})).ok,true)
    contexts[1].state({generation:2})
    contexts[0].state({generation:1})
    contexts[0].log('warn','stale-generation-log')
    const generationStatus=await ga('status')
    assert.equal(generationStatus.statuses[0].value.generation,2,'old state cannot overwrite a rebound instance')
    assert.ok(!generationStatus.logs.some(entry=>entry.message==='stale-generation-log'),'late old logs are ignored')
    let releaseWrite
    let writing=false
    const originalWrite=generation.store.writeState.bind(generation.store)
    generation.store.writeState=async(...args)=>{
      writing=true
      await new Promise(resolve=>{releaseWrite=resolve})
      return originalWrite(...args)
    }
    const deleting=ga('instance:delete',{instanceId:generationInstance.id})
    await until(()=>writing,'delete awaiting persistence')
    const rebinding=ga('bind',{instanceId:generationInstance.id})
    releaseWrite()
    assert.equal((await deleting).ok,true)
    assert.equal((await rebinding).ok,false,'bind waits for delete and cannot resurrect deleted instance')
    assert.equal((await ga('status')).statuses.length,0)
    await generation.dispose('*')
    console.log('plugin backend: schema, directory/JSON install, process RPC, immediate replies, auto send, redaction, cancellation, crash, reconnect, persistence, migration, generation, admission races PASS')
  } finally { await ownedService?.dispose('*'); for(const child of ownedProcesses) if(child.exitCode===null&&child.signalCode===null)child.kill(); await fs.rm(root,{recursive:true,force:true}) }
}
main().catch(error=>{console.error(error);process.exitCode=1})
