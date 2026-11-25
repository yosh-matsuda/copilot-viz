import { h, icon, setData, setText } from './ui.mjs';

function duration(ms) {
  for (const [suffix, unit] of [['d', 864e5], ['h', 36e5], ['m', 6e4]]) {
    if (ms > 0 && ms % unit === 0) return `${ms / unit}${suffix}`;
  }
  return `${ms / 1000}s`;
}

function checkHint(message) {
  if (/Cannot run SSH/.test(message)) return 'Install OpenSSH on the machine running copilot-viz.';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(message)) {
    return 'Run ssh to this host in a terminal and verify its fingerprint with the host administrator before accepting it.';
  }
  if (/Permission denied|agent refused|sign_and_send_pubkey/i.test(message)) {
    return 'Unlock the key in ssh-agent and verify ssh -o BatchMode=yes to this host. Password prompts are not supported.';
  }
  if (/Could not resolve hostname/i.test(message)) return 'Check the host name or SSH Host alias on the machine running copilot-viz.';
  if (/not found|No such file|Node.js 22|bad option/i.test(message)) return 'Use Node.js 22 or later on the host. Set an absolute Node.js path under Advanced if its non-interactive PATH is different.';
  return '';
}

export function createSettings(dialog, { request }) {
  const $ = (name) => dialog.querySelector(`#settings-${name}`);
  const form = $('form');
  const fields = $('fields');
  const message = $('message');
  const save = $('save');
  const reload = $('reload');
  const closeButtons = [...dialog.querySelectorAll('[data-settings-close]')];
  const add = $('add');
  const list = $('remotes');
  const runtimeFields = { since: $('since'), idleExitMinutes: $('idle'), pauseRemotesMinutes: $('pause') };
  let data = null;
  let rows = [];
  let hosts = new Map();
  let generation = 0;
  let nextId = 0;
  let pending = null;
  let saving = false;

  function tell(text, tone = '') {
    setText(message, text);
    setData(message, 'tone', tone);
  }

  function lock() {
    fields.disabled = !data || Boolean(pending) || data.readOnly;
    save.disabled = fields.disabled;
    reload.disabled = Boolean(pending);
    add.disabled = rows.length >= 32;
    for (const button of closeButtons) button.disabled = saving;
    dialog.setAttribute('aria-busy', String(Boolean(pending)));
  }

  function restoreFocus(button) {
    const doc = dialog.ownerDocument;
    if (dialog.open && (doc.activeElement === doc.body || doc.activeElement === dialog)) button.focus();
  }

  function cancelCheck(row) {
    row.checking?.abort();
    row.checking = null;
    row.check.disabled = false;
    row.result.hidden = true;
  }

  function close() {
    generation++;
    pending?.abort();
    pending = null;
    saving = false;
    for (const row of rows) cancelCheck(row);
    dialog.close();
  }

  function remoteValue(row) {
    return {
      host: row.inputs.host.value.trim(), node: row.inputs.node.value || 'node',
      ...(row.inputs.script.value ? { script: row.inputs.script.value } : {}),
      ...(row.inputs.copilotHome.value ? { copilotHome: row.inputs.copilotHome.value } : {}),
    };
  }

  function connections() {
    for (const row of rows) {
      const value = remoteValue(row);
      const saved = data?.config.remotes.find((remote) => remote.host === value.host);
      const applied = data?.appliedRemotes.find((remote) => remote.host === value.host);
      const matches = (remote) => remote && ['host', 'node', 'script', 'copilotHome'].every((key) => remote[key] === value[key]);
      const same = matches(saved);
      const active = same && matches(applied);
      const host = active && hosts.get(`ssh:${value.host}`);
      setText(row.state, host ? `${host.state}${host.error ? `: ${host.error}` : ''}`
        : active ? 'Waiting for connection status' : same ? 'Saved, not applied' : 'Not saved');
      setData(row.state, 'state', host?.state ?? 'draft');
    }
  }

  async function check(row) {
    if (!row.inputs.host.reportValidity()) return;
    const focused = dialog.ownerDocument.activeElement === row.check;
    cancelCheck(row);
    const controller = new AbortController();
    row.checking = controller;
    row.check.disabled = true;
    row.result.hidden = false;
    setData(row.result, 'tone', '');
    setText(row.result, 'Checking SSH and Node.js...');
    try {
      const result = await request('/api/remotes/check', { method: 'POST', body: { remote: remoteValue(row) }, signal: controller.signal });
      if (row.checking !== controller) return;
      setData(row.result, 'tone', 'success');
      setText(row.result, `SSH ready. Node.js ${result.nodeVersion} at ${result.nodePath}.\n${result.copilotHome}: ${result.sessions
        ? 'the session directory is readable.' : 'no session directory yet; start Copilot CLI on this host.'}`);
    } catch (error) {
      if (row.checking !== controller) return;
      setData(row.result, 'tone', 'error');
      setText(row.result, [error.message, checkHint(error.message)].filter(Boolean).join('\n'));
    } finally {
      if (row.checking === controller) {
        row.checking = null;
        row.check.disabled = false;
        if (focused) restoreFocus(row.check);
      }
    }
  }

  function addRemote(remote = {}) {
    const id = ++nextId;
    const row = { inputs: {}, checking: null };
    const legend = h('legend', { text: remote.host || 'New SSH host' });
    function input(key, label, placeholder, hint = '') {
      const name = `settings-remote-${id}-${key}`;
      const field = h('input', {
        id: name, type: 'text', value: remote[key] ?? '', placeholder, required: key === 'host',
        maxlength: key === 'host' ? 128 : 1024, autocomplete: 'off', spellcheck: 'false',
        'aria-describedby': hint ? `${name}-hint` : undefined,
      });
      row.inputs[key] = field;
      return h('div', { class: 'settings-field' }, h('label', { for: name, text: label }), field,
        hint ? h('small', { id: `${name}-hint`, text: hint }) : null);
    }
    const host = input('host', 'SSH host', 'build-server', 'An SSH Host alias or user@hostname.');
    const advanced = h('details', { class: 'settings-advanced', open: Boolean(remote.copilotHome || remote.script || (remote.node && remote.node !== 'node')) },
      h('summary', { text: 'Advanced paths' }),
      input('node', 'Node.js executable', 'node', 'An absolute path is useful when non-interactive SSH has a different PATH.'),
      input('copilotHome', 'Remote Copilot home', 'Remote COPILOT_HOME, or .copilot', 'Absolute or relative to the remote home. Paths are literal; ~ and environment variables are not expanded.'),
      input('script', 'Custom worker script', 'Automatic installation', 'For development only. The connection check does not run or validate this script.'));
    row.state = h('p', { class: 'settings-connection', 'aria-live': 'polite' });
    row.result = h('p', { class: 'settings-notice', role: 'status', hidden: true });
    row.check = h('button', { class: 'settings-btn', type: 'button', text: 'Check connection', onclick: () => check(row) });
    const remove = h('button', { class: 'settings-btn', type: 'button', text: 'Remove', onclick: () => {
      cancelCheck(row);
      rows = rows.filter((item) => item !== row);
      row.element.remove();
      tell('Unsaved changes.');
      lock();
      add.focus();
    } });
    row.element = h('fieldset', { class: 'settings-remote' },
      legend, host, row.state, advanced,
      h('div', { class: 'settings-actions' }, row.check, remove), row.result);
    row.element.addEventListener('input', () => {
      cancelCheck(row);
      setText(legend, row.inputs.host.value.trim() || 'New SSH host');
      connections();
    });
    rows.push(row);
    list.append(row.element);
    connections();
    lock();
    return row;
  }

  function fill(next) {
    if (next?.config?.version !== 2 || !Array.isArray(next.config.remotes) || !Array.isArray(next.appliedRemotes) || !next.runtime || !next.defaults) {
      throw new Error('Incompatible settings response. Run copilot-viz again after an upgrade.');
    }
    for (const row of rows) cancelCheck(row);
    data = next;
    rows = [];
    list.replaceChildren();
    for (const [key, input] of Object.entries(runtimeFields)) input.value = next.config[key] ?? '';
    runtimeFields.since.placeholder = duration(next.defaults.sinceMs);
    runtimeFields.idleExitMinutes.placeholder = String(next.defaults.idleExitMs / 60_000);
    runtimeFields.pauseRemotesMinutes.placeholder = String(next.defaults.remotePauseMs / 60_000);
    setText($('since-current'), `Active: ${duration(next.runtime.sinceMs)}. Blank uses this launch's default: ${duration(next.defaults.sinceMs)}.`);
    const minutes = (ms) => ms === 0 ? 'never' : `${ms / 60_000} min`;
    setText($('idle-current'), `Active: ${minutes(next.runtime.idleExitMs)}. Blank uses this launch's default: ${minutes(next.defaults.idleExitMs)}.`);
    setText($('pause-current'), `Active: ${minutes(next.runtime.remotePauseMs)}. Blank uses this launch's default: ${minutes(next.defaults.remotePauseMs)}.`);
    setText($('machine'), next.hostname);
    setText($('path'), next.path);
    $('readonly').hidden = !next.readOnly;
    setText($('readonly'), next.readOnlyReason ?? 'This configuration is linked to another file. Edit it manually; the dashboard will not replace the link.');
    for (const remote of next.config.remotes) addRemote(remote);
    lock();
  }

  async function load() {
    const focused = dialog.ownerDocument.activeElement === reload;
    const current = ++generation;
    pending?.abort();
    for (const row of rows) cancelCheck(row);
    const controller = new AbortController();
    pending = controller;
    data = null;
    lock();
    tell('Loading settings...');
    try {
      const next = await request('/api/settings', { signal: controller.signal });
      if (current !== generation) return;
      fill(next);
      tell(next.error ?? 'Saved values apply when you choose Save and apply.', next.error ? 'error' : '');
    } catch (error) {
      if (current === generation) tell(error.message, 'error');
    } finally {
      if (current === generation) {
        pending = null;
        lock();
        if (focused) restoreFocus(reload);
      }
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (!data || pending || data.readOnly || !form.reportValidity()) return;
    const config = { version: 2, remotes: rows.map(remoteValue) };
    const since = runtimeFields.since.value.trim();
    if (since) config.since = since;
    for (const key of ['idleExitMinutes', 'pauseRemotesMinutes']) {
      if (runtimeFields[key].value !== '') config[key] = runtimeFields[key].valueAsNumber;
    }
    for (const row of rows) cancelCheck(row);
    const current = generation;
    const controller = new AbortController();
    pending = controller;
    saving = true;
    lock();
    tell('Saving and applying settings...');
    try {
      const next = await request('/api/settings', {
        method: 'PUT', body: { revision: data.revision, config }, signal: controller.signal,
      });
      if (current !== generation) return;
      fill(next);
      tell('Saved and applied. Connection status is shown below each host.', 'success');
    } catch (error) {
      if (current === generation) tell(`${error.message} Reload saved settings if the save result is uncertain.`, 'error');
    } finally {
      if (current === generation) {
        pending = null;
        saving = false;
        lock();
        restoreFocus(save);
      }
    }
  }

  for (const button of closeButtons) button.addEventListener('click', () => { if (!saving) close(); });
  $('close-icon').replaceChildren(icon('close'));
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (!saving) close();
  });
  form.addEventListener('submit', submit);
  form.addEventListener('input', () => tell('Unsaved changes.'));
  reload.addEventListener('click', load);
  add.addEventListener('click', () => {
    if (rows.length >= 32) return;
    const row = addRemote();
    tell('Unsaved changes.');
    row.inputs.host.focus();
  });
  return {
    open() {
      if (dialog.open) return;
      dialog.showModal();
      $('title').focus();
      load();
    },
    close,
    cancel: () => { if (!saving) close(); },
    isOpen: () => dialog.open,
    updateHosts(next) {
      hosts = next;
      if (dialog.open) connections();
    },
  };
}
