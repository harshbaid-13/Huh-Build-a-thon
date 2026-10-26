const openTab = (url: string) => void chrome.tabs.create({ url });

document.getElementById('shortcuts')!.addEventListener('click', () => openTab('chrome://extensions/shortcuts'));
document.getElementById('options')!.addEventListener('click', () => void chrome.runtime.openOptionsPage());

void chrome.commands.getAll().then((cmds) => {
  const sc = cmds.find((c) => c.name === 'trigger-huh')?.shortcut;
  if (sc) document.querySelectorAll('.sc').forEach((el) => (el.textContent = sc));
});
export {};
