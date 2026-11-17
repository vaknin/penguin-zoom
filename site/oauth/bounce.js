// Zoom's authorize page only accepts this https redirect, so Zoom sends the
// browser here after sign-in. Hand the result straight to Penguin on this
// computer (its local server on 127.0.0.1:53682 exchanges the code with PKCE;
// the code is useless without the verifier Penguin keeps in memory). Nothing
// is sent to or stored by this site; it has no access logs.
(function () {
  var q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return; // opened by hand: just show the page
  if (q.has('code') && !q.has('state')) {
    // Added from the Zoom App Marketplace, not from the app (Penguin always
    // sends a state). Don't forward: Penguin didn't start this and would
    // refuse it. Point the user to the app instead.
    document.querySelector('h1').textContent = 'Penguin for Zoom is added';
    document.getElementById('msg').innerHTML = 'Penguin for Zoom is now added to your Zoom account. It runs on your Linux computer: <a href="../docs.html#install">install it</a>, open <strong>Settings</strong> (the gear at the top right) and press <strong>Sign in</strong>.';
    return;
  }
  document.getElementById('msg').textContent = 'Returning to Penguin…';
  location.replace('http://127.0.0.1:53682/oauth/callback' + location.search);
})();
