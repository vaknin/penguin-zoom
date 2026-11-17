// Zoom's authorize page only accepts this https redirect, so Zoom sends the
// browser here after sign-in. Hand the result straight to Penguin on this
// computer (its local server on 127.0.0.1:53682 exchanges the code with PKCE;
// the code is useless without the verifier Penguin keeps in memory). Nothing
// is sent to or stored by this site; it has no access logs.
(function () {
  var q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return; // opened by hand: just show the page
  document.getElementById('msg').textContent = 'Returning to Penguin…';
  location.replace('http://127.0.0.1:53682/oauth/callback' + location.search);
})();
