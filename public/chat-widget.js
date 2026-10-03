/* TradeX AI Chat Widget — floating assistant. Backend: POST /api/chat */
(function () {
  if (document.getElementById('tx-chat-btn')) return;

  var btn = document.createElement('button');
  btn.id = 'tx-chat-btn';
  btn.title = 'Chat with TradeX Assistant';
  btn.textContent = '\uD83E\uDD16'; // robot emoji

  var panel = document.createElement('div');
  panel.id = 'tx-chat-panel';
  panel.innerHTML =
    '<div id="tx-chat-head"><div>TradeX Assistant<small id="tx-chat-mode">online</small></div>' +
    '<button id="tx-chat-close" aria-label="Close">&times;</button></div>' +
    '<div id="tx-chat-msgs"></div>' +
    '<form id="tx-chat-form"><input id="tx-chat-input" type="text" placeholder="Ask about trading, deposits..." autocomplete="off" maxlength="500"/>' +
    '<button id="tx-chat-send" type="submit" aria-label="Send">\u27A4</button></form>';

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  var msgs = panel.querySelector('#tx-chat-msgs');
  var form = panel.querySelector('#tx-chat-form');
  var input = panel.querySelector('#tx-chat-input');
  var greeted = false;

  function addMsg(text, who) {
    var d = document.createElement('div');
    d.className = 'tx-msg ' + who;
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  }

  function toggle(open) {
    var willOpen = open === undefined ? !panel.classList.contains('open') : open;
    panel.classList.toggle('open', willOpen);
    if (willOpen && !greeted) {
      greeted = true;
      addMsg('Hello! I am the TradeX Assistant. Ask me about trading, timeframes, deposits, or demo mode!', 'bot');
    }
    if (willOpen) input.focus();
  }

  btn.addEventListener('click', function () { toggle(); });
  panel.querySelector('#tx-chat-close').addEventListener('click', function () { toggle(false); });

  // Only show the widget on the landing page (#/home or empty hash).
  function onHome(){
    var h = location.hash || '';
    return h === '' || h === '#/home' || h.indexOf('#/home?') === 0;
  }
  function syncVisibility(){
    var show = onHome();
    btn.style.display = show ? '' : 'none';
    if(!show) panel.classList.remove('open');
  }
  window.addEventListener('hashchange', syncVisibility);
  syncVisibility();

  // Show which brain is active (ai vs smart)
  fetch('/api/chat/mode').then(function (r) { return r.json(); }).then(function (j) {
    panel.querySelector('#tx-chat-mode').textContent = j.mode === 'ai' ? 'AI online' : 'online';
  }).catch(function () {});

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    addMsg(text, 'user');
    input.value = '';
    var typing = addMsg('Typing...', 'bot typing');
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    }).then(function (r) { return r.json(); }).then(function (j) {
      typing.remove();
      addMsg(j.reply || 'Sorry, something went wrong. Try again!', 'bot');
    }).catch(function () {
      typing.remove();
      addMsg('Connection hiccup — please try again!', 'bot');
    });
  });
})();
