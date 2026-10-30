import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHarnessSession, prepareHarness, registerHarness, validateHarness } from '../src/harnesses.mjs';
const exec = promisify(execFile);
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

async function fixture() {
  const stateRoot = await mkdtemp(join(tmpdir(), 'harness-program-test-'));
  const harness = await registerHarness({id:'fixture', package:'fixture-harness', command:'fixture'}, {stateRoot});
  let version = '1.0.0', installs = 0, checks = 0, failed = false;
  const options = {
    id: harness.id, image: 'fixture-image', stateRoot,
    inspect: async () => ({id:'sha256:fixture', platform:'linux/arm64'}),
    fetchMetadata: async () => {checks++; return {ok:true, json:async () => ({version})};},
    resolveProxy: async () => ({environment:{}}), readTrustBundle: async () => undefined,
    docker: async args => {
      if (args.at(-2) === '-c' && args.at(-1).startsWith('npm install')) {
        installs++;
        const destination = args.find(arg => arg.includes('dst=/program') && arg.startsWith('type=bind')).split(',')[1].slice(4);
        const target = args.at(-1).match(/fixture-harness@([^']+)/)[1];
        await mkdir(join(destination,'bin'), {recursive:true});
        await mkdir(join(destination,'lib/node_modules/fixture-harness'), {recursive:true});
        await writeFile(join(destination,'bin/fixture'), '#!/bin/sh\necho fixture\n', {mode:0o755});
        await writeFile(join(destination,'lib/node_modules/fixture-harness/package.json'), JSON.stringify({version:target}));
      } else if (failed) throw new Error('Version probe failed');
      return 'fixture';
    },
  };
  return {options, counts:() => ({installs,checks}), version:value => {version=value;}, fail:value => {failed=value;}, close:() => rm(stateRoot,{recursive:true,force:true})};
}

test('concurrent starts install once and reuse a verified program without repeated registry checks', async () => {
  const f = await fixture();
  try {
    const [one,two] = await Promise.all([prepareHarness(f.options), prepareHarness(f.options)]);
    assert.equal(one.release,two.release);
    assert.deepEqual(f.counts(),{installs:1,checks:1});
    assert.equal((await readJson(join(one.root,'current.json'))).version,'1.0.0');
    assert.equal((await prepareHarness({...f.options,offline:true})).release,one.release);
    assert.deepEqual(f.counts(),{installs:1,checks:1});
  } finally {await f.close();}
});

test('an upgrade publishes a new release, retains the previous executable and preserves current on failure', async () => {
  const f = await fixture();
  try {
    const one = await prepareHarness(f.options);
    f.version('2.0.0');
    const two = await prepareHarness({...f.options,force:true});
    assert.notEqual(one.release,two.release);
    assert.equal((await readJson(join(one.root,'current.json'))).version,'2.0.0');
    assert.match(await readFile(join(one.root,'releases',one.release,'bin/fixture'),'utf8'), /fixture/);
    f.version('3.0.0'); f.fail(true);
    await assert.rejects(prepareHarness({...f.options,force:true}),/Version probe failed/);
    assert.equal((await readJson(join(one.root,'current.json'))).release,two.release);
    assert.equal((await readdir(join(one.root,'releases'))).length,2);
  } finally {await f.close();}
});

test('pinned versions do not change the shared current release or latest-check cache', async () => {
  const f = await fixture();
  try {
    const current = await prepareHarness(f.options);
    const pinned = await prepareHarness({...f.options,version:'0.9.0'});
    assert.equal(pinned.version,'0.9.0');
    assert.equal((await readJson(join(current.root,'current.json'))).release,current.release);
    assert.equal((await prepareHarness({...f.options,version:'0.9.0',offline:true})).release,pinned.release);
    assert.deepEqual(f.counts(),{installs:2,checks:1});
    await assert.rejects(prepareHarness({...f.options,version:'0.8.0',offline:true}), {code:'HARNESS_OFFLINE'});
  } finally {await f.close();}
});

test('an automatic registry failure keeps the existing version usable', async () => {
  const f = await fixture();
  try {
    const current = await prepareHarness(f.options);
    await writeFile(join(current.root,'check.json'),JSON.stringify({checkedAt:0}));
    const result = await prepareHarness({...f.options,fetchMetadata:async () => {throw new Error('Network unavailable');}});
    assert.equal(result.release,current.release);
    assert.match(result.updateError,/Network unavailable/);
  } finally {await f.close();}
});

async function response(directory,id) {
  for(let i=0;i<100;i++) {
    try {return await readJson(join(directory,`${id}.response.json`));}
    catch(error){if(error.code!=='ENOENT')throw error;}
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw new Error('Missing broker response');
}

test('the private broker accepts native/npm upgrades and rejects extra actions and host symlinks', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(),'harness-broker-test-'));
  let updates=0;
  const session = await createHarnessSession({id:'fixture',image:'fixture',stateRoot,prepare:async options => {
    if(options.force) updates++;
    return {id:'fixture',command:'fixture',package:'fixture-harness',version:'2.0.0',release:'release',root:join(stateRoot,'program')};
  }});
  try {
    const client=join(session.directory,'client.mjs');
    for(const args of [['fixture','update'],['npm','install','-g','fixture-harness@latest'],['harness-update']]) {
      const result=await exec(process.execPath,[client,...args],{timeout:5000});
      assert.match(result.stdout,/ready at 2.0.0/);
    }
    assert.equal(updates,3);
    const invalid=randomUUID();
    await writeFile(join(session.directory,`${invalid}.request.json`),JSON.stringify({action:'update',image:'arbitrary-image'}));
    assert.equal((await response(session.directory,invalid)).ok,false);
    const secret=join(stateRoot,'secret'); await writeFile(secret,'host-secret-must-not-be-read');
    const linked=randomUUID(); await symlink(secret,join(session.directory,`${linked}.request.json`));
    const refused=await response(session.directory,linked);
    assert.equal(refused.ok,false); assert.equal(JSON.stringify(refused).includes('host-secret'),false);
    assert.equal(updates,3);
    assert.ok(session.dockerArgs.some(arg=>arg.includes('dst=/opt/isolated-harness/program,readonly')));
    assert.equal(session.dockerArgs.some(arg=>arg.includes('docker.sock')),false);
  } finally {await session.close(); await rm(stateRoot,{recursive:true,force:true});}
});

test('registration rejects shell fragments and executable names reserved by the control layer', () => {
  assert.throws(()=>validateHarness({id:'safe',package:'pkg;echo',command:'safe'}),{code:'HARNESS_INVALID'});
  assert.throws(()=>validateHarness({id:'safe',package:'pkg',command:'node'}),{code:'HARNESS_INVALID'});
});

test('a due automatic check upgrades while --no-auto-update keeps the cached release', async () => {
  const f=await fixture();
  try {
    const old=await prepareHarness(f.options);
    f.version('2.0.0');
    await writeFile(join(old.root,'check.json'),JSON.stringify({checkedAt:0}));
    assert.equal((await prepareHarness({...f.options,autoUpdate:false})).version,'1.0.0');
    assert.equal((await prepareHarness(f.options)).version,'2.0.0');
    assert.deepEqual(f.counts(),{installs:2,checks:2});
  } finally {await f.close();}
});

test('offline and pinned sessions reject update requests even if the container bypasses its client', async () => {
  for (const policy of [{offline:true},{version:'1.0.0'}]) {
    const stateRoot=await mkdtemp(join(tmpdir(),'harness-policy-test-'));
    let updates=0;
    const session=await createHarnessSession({id:'fixture',image:'fixture',stateRoot,...policy,prepare:async options=>{
      if(options.force)updates++;
      return {command:'fixture',package:'fixture-harness',version:'1.0.0',release:'release',root:join(stateRoot,'program')};
    }});
    try {
      const id=randomUUID();
      await writeFile(join(session.directory,`${id}.request.json`),JSON.stringify({action:'update'}));
      assert.equal((await response(session.directory,id)).ok,false);
      assert.equal(updates,0);
    } finally {await session.close();await rm(stateRoot,{recursive:true,force:true});}
  }
});
