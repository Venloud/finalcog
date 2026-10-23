(() => {
  const root = document.documentElement;
  const body = document.body;
  const menuButton = document.querySelector('#navGear');
  const menu = document.querySelector('#gearMenu');
  const platformButtons = [...document.querySelectorAll('[data-platform-select]')];
  const platformNote = document.querySelector('#platformNote');
  const dialog = document.querySelector('#authDialog');
  const dialogTitle = document.querySelector('#dialogTitle');
  const dialogEyebrow = document.querySelector('#dialogEyebrow');
  const dialogIntro = document.querySelector('#dialogIntro');
  const emailField = document.querySelector('#signupEmail');
  const form = document.querySelector('#earlyAccessForm');
  const settings = {
    tiktok: {color: '#25f4ee', soft: 'rgba(37,244,238,.13)', note: 'TikTok is our first publishing destination. The platform is in development.'}
  };
  const setPlatform = (name) => {
    const selected = settings[name];
    if (!selected) return;
    body.dataset.platform = name;
    try { localStorage.setItem("finalcog.platform", name); } catch {}
    root.style.setProperty('--accent',selected.color);
    root.style.setProperty('--accent-soft',selected.soft);
    platformNote.textContent = selected.note;
    for (const button of platformButtons) {
      const active = button.dataset.platformSelect === name;
      button.classList.toggle('active',active);
      button.setAttribute('aria-pressed',String(active));
    }
  };
  platformButtons.forEach(button => button.addEventListener('click', () => setPlatform(button.dataset.platformSelect)));
  try {
    const rememberedPlatform = localStorage.getItem('finalcog.platform');
    setPlatform(settings[rememberedPlatform] ? rememberedPlatform : 'tiktok');
  } catch { setPlatform('tiktok'); }
  const closeMenu = () => { menu.hidden = true; menuButton.setAttribute('aria-expanded','false'); };
  menuButton.addEventListener('click', () => {
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    menuButton.setAttribute('aria-expanded',String(willOpen));
  });
  menu.querySelectorAll('a').forEach(link => link.addEventListener('click',closeMenu));
  document.addEventListener('click',event => { if(!menu.hidden && !event.target.closest('.nav-control')) closeMenu(); });
  document.addEventListener('keydown',event => { if(event.key === 'Escape')closeMenu(); });
  const modes = {
    join:['GET EARLY ACCESS','Your content deserves momentum.','The landing page is live, but creator accounts and automatic publishing are still being built. You can ask for early access by email.'],
    email:['EMAIL ACCESS','An inbox for your next big idea.','Email login is not available yet. You can request an invite below, which opens your own email app.'],
    login:['ACCOUNT LOGIN','The machines are warming up.','We have not opened creator accounts yet. There is no live login service on this preview. You can request early access below.']
  };
  const workspaceDialog = document.querySelector('#workspaceDialog');
  let workspaceFocus;
  document.querySelectorAll('[data-utility]').forEach(button => button.addEventListener('click', () => {
    workspaceFocus = button;
    const isSettings = button.dataset.utility === 'settings';
    document.querySelector('#workspaceTitle').textContent = isSettings ? 'Your workspace.' : 'Your momentum.';
    document.querySelector('#workspaceBody').innerHTML = isSettings
       ? '<p class="form-note">TikTok is the only destination in this demo workspace.</p><label for="defaultPlatform">Default platform</label><select id="defaultPlatform"><option value="tiktok">TikTok</option></select><p class="form-note">Accounts and live integrations are not connected.</p>'
      : '<p class="form-note">Live analytics will be available after platform integrations launch. You can review your saved demo drafts and schedules now.</p><a class="button button-outline" href="studio.html#publishing">View demo history ↗</a>';
    if (isSettings) {
      const select = document.querySelector('#defaultPlatform');
       select.value = 'tiktok';
      select.addEventListener('change', () => setPlatform(select.value));
    }
    workspaceDialog.showModal();
  }));
  document.querySelector('#closeWorkspace').addEventListener('click', () => workspaceDialog.close());
  workspaceDialog.addEventListener('close', () => workspaceFocus?.focus());
  workspaceDialog.addEventListener('click', event => { if (event.target === workspaceDialog) workspaceDialog.close(); });
  let returnFocus = null;
  const openDialog = (mode) => {
    const [eyebrow,title,intro]=modes[mode] || modes.join;
    returnFocus = document.activeElement;
    dialogEyebrow.textContent = eyebrow;
    dialogTitle.textContent = title;
    dialogIntro.textContent = intro;
    dialog.showModal();
    emailField.focus();
  };
  document.querySelectorAll('[data-open-auth]').forEach(button => button.addEventListener('click',() => openDialog(button.dataset.openAuth)));
  document.querySelector('#closeDialog').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',event => { if(event.target === dialog)dialog.close(); });
  dialog.addEventListener('close',()=>returnFocus?.focus());
  form.addEventListener('submit',event => {
    event.preventDefault();
    if(!form.reportValidity())return;
    const email=emailField.value.trim();
    const subject=encodeURIComponent('Final Cog early access request');
    const message=encodeURIComponent('Hi Final Cog team,\n\nPlease contact me about early access.\n\nMy email: '+email+'\n\nThanks!');
    window.location.href='mailto:van02.vlcb@gmail.com?subject='+subject+'&body='+message;
  });
  document.querySelector('#year').textContent=String(new Date().getFullYear());
})();
