/** Installation-relative, verified private MSYS runtime for confined Windows calls.
 * Original payloads remain untouched. Full access does not select this runtime.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { patchMsys } from './bash-pe.js'
const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const cache=new Map()
const proxies=path.join(packageRoot,'runtime/win32-x64/bash-ipc')
const SOURCES={config:'configured bashPath',path:'system bash on PATH','well-known':'system Git for Windows install',bundled:'bundled bash',provisioned:'provisioned bash'}
// Resolve both PortableGit's bin wrapper and its real usr/bin executable.
function msysRoot(file) {
  const directory=path.dirname(file)
  return path.basename(directory).toLowerCase()==='bin' && path.basename(path.dirname(directory)).toLowerCase()==='usr'
    ? path.resolve(directory,'../..') : path.resolve(directory,'..')
}
/** The one actionable explanation for a bash that restricted modes cannot run (#42). */
export function restrictedRemedy(file, source, why) {
  const label=SOURCES[source] ? `${SOURCES[source]} ` : ''
  return `EXECUTOR_UNAVAILABLE: ops_bash cannot run the ${label}${file} in restricted modes (read-only / workspace-write): ${why} `
    +'By design, restricted modes run only the pinned MSYS whose DSH IPC compatibility proxies were verified; this is not a user authorization denial. '
    +'A custom bashPath or system Git for Windows works only in danger-full-access. '
    +'Next steps: remove bashPath (and allowSystemShellFallback) so the bundled or provisioned pinned bash is used (`dsh-ops provision-shells --bash` if it is missing), '
    +'or ask the user to switch the session to danger-full-access. ops_bash has no per-call sandbox_permissions escalation; do not bypass confinement.'
}
/** Whether restricted modes can run this bash, without copying or building anything. */
export function restrictedCompatibility(file, {platform=process.platform}={}) {
  if(platform!=='win32')return {compatible:true,reason:'no MSYS IPC compatibility layer is needed on this platform'}
  const dll=path.join(msysRoot(file),'usr/bin/msys-2.0.dll')
  if(!fs.existsSync(dll))return {compatible:false,reason:`it has no usr/bin/msys-2.0.dll beside it (${dll}), which is not the supported MSYS payload layout.`}
  let receipt
  try { receipt=JSON.parse(fs.readFileSync(path.join(proxies,'provenance.json'),'utf8')) }
  catch { return {compatible:false,reason:'this dsh-ops installation carries no Bash IPC compatibility receipt (runtime/win32-x64/bash-ipc/provenance.json).'} }
  const msysSha256=hash(fs.readFileSync(dll))
  if(receipt.platform==='win32-x64' && receipt.msysSha256===msysSha256)return {compatible:true,reason:'its msys-2.0.dll matches the pinned MSYS build',msysSha256,expectedSha256:receipt.msysSha256}
  return {compatible:false,msysSha256,expectedSha256:receipt.msysSha256,
    reason:`its msys-2.0.dll (sha256 ${msysSha256.slice(0,12)}…) is not the pinned build (${String(receipt.msysSha256).slice(0,12)}…).`}
}
export function confinedBash(file, {home=process.env.DSH_HOME ?? path.join(os.homedir(),'.dsh'), platform=process.platform, source}={}) {
  if(platform!=='win32')return {file}
  const root=msysRoot(file)
  const check=restrictedCompatibility(file,{platform})
  if(!check.compatible)throw Error(restrictedRemedy(file,source,check.reason))
  const bytes=fs.readFileSync(path.join(root,'usr/bin/msys-2.0.dll'))
  const receipt=JSON.parse(fs.readFileSync(path.join(proxies,'provenance.json'),'utf8'))
  const proxyBytes={}
  for(const name of ['opsipc.dll','opsnt.dll']){
    proxyBytes[name]=fs.readFileSync(path.join(proxies,name))
    if(hash(proxyBytes[name])!==receipt.files[name])throw Error(`Bash IPC provenance mismatch: ${name}`)
  }
  const identity=hash(Buffer.from(JSON.stringify({root,msys:receipt.msysSha256,files:receipt.files}))).slice(0,24)
  const target=path.join(home,'dsh-ops/bash-ipc',identity)
  const selected=path.join(target,'usr/bin/bash.exe')
  const key=path.resolve(target)
  if(cache.has(key)) {
    const value=cache.get(key)
    if(hash(fs.readFileSync(path.join(target,'usr/bin/msys-2.0.dll')))!==hash(patchMsys(bytes).bytes) ||
      !['opsipc.dll','opsnt.dll'].every(name=>hash(fs.readFileSync(path.join(target,'usr/bin',name)))===receipt.files[name])) {
      throw Error('Bash IPC cached runtime integrity mismatch; refusing execution.')
    }
    return value
  }
  const patched=patchMsys(bytes).bytes
  const marker=path.join(target,'.ops-ipc.json')
  let valid=false
  try {
    const saved=JSON.parse(fs.readFileSync(marker,'utf8'))
    valid=saved.identity===identity && fs.existsSync(selected) && hash(fs.readFileSync(path.join(target,'usr/bin/msys-2.0.dll')))===hash(patched) &&
      ['opsipc.dll','opsnt.dll'].every(name=>hash(fs.readFileSync(path.join(target,'usr/bin',name)))===receipt.files[name])
  } catch {}
  if(!valid){
    // Never overwrite a possibly running generation. Failed incomplete builds
    // get a new staging directory and only complete copies are published.
    fs.mkdirSync(path.dirname(target),{recursive:true})
    const stage=fs.mkdtempSync(path.join(path.dirname(target),'stage-'))
    try {
      fs.cpSync(root,stage,{recursive:true,filter:source=>!['.git','node_modules'].includes(path.basename(source))})
      fs.writeFileSync(path.join(stage,'usr/bin/msys-2.0.dll'),patched)
      for(const [name,data] of Object.entries(proxyBytes))fs.writeFileSync(path.join(stage,'usr/bin',name),data)
      fs.writeFileSync(path.join(stage,'.ops-ipc.json'),JSON.stringify({identity,source:root,msys:receipt.msysSha256,patchedSha256:hash(patched),files:receipt.files})+'\n')
      if(fs.existsSync(target))throw Error('Bash IPC runtime integrity mismatch; refusing to overwrite an existing generation.')
      try {fs.renameSync(stage,target)} catch(error){if(!fs.existsSync(marker))throw error}
    } finally {fs.rmSync(stage,{recursive:true,force:true})}
  }
  const result={file:selected,env:{PATH:[path.join(target,'usr/bin'),path.join(target,'ucrt64/bin'),path.join(target,'cmd'),process.env.PATH??''].join(path.delimiter)},runtime:identity}
  cache.set(key,result)
  return result
}
