(function () {
  function bytesToB64url(bytes) {
    let binary = '';
    const view = new Uint8Array(bytes);
    for (const byte of view) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlToBuffer(value) {
    const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function publicKeyRequest(options) {
    const key = Object.assign({}, options);
    key.challenge = b64urlToBuffer(options.challenge);
    if (options.user) {
      key.user = Object.assign({}, options.user, { id: b64urlToBuffer(options.user.id) });
    }
    ['excludeCredentials', 'allowCredentials'].forEach((name) => {
      if (!options[name]) return;
      key[name] = options[name].map((item) => Object.assign({}, item, { id: b64urlToBuffer(item.id) }));
    });
    return key;
  }

  function credentialJSON(credential) {
    const response = {
      clientDataJSON: bytesToB64url(credential.response.clientDataJSON)
    };
    if (credential.response.attestationObject) {
      response.attestationObject = bytesToB64url(credential.response.attestationObject);
    }
    if (credential.response.authenticatorData) {
      response.authenticatorData = bytesToB64url(credential.response.authenticatorData);
    }
    if (credential.response.signature) {
      response.signature = bytesToB64url(credential.response.signature);
    }
    if (credential.response.userHandle) {
      response.userHandle = bytesToB64url(credential.response.userHandle);
    }
    return {
      id: credential.id,
      rawId: bytesToB64url(credential.rawId),
      type: credential.type,
      response
    };
  }

  async function post(body) {
    const response = await fetch('/api/passkey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not use Touch ID or Face ID.');
    return data;
  }

  function friendly(error) {
    if (error && error.name === 'NotAllowedError') return 'Touch ID or Face ID was cancelled.';
    if (error && error.name === 'InvalidStateError') return 'This device is already set up for your account.';
    return (error && error.message) || 'Could not use Touch ID or Face ID.';
  }

  window.KBPasskey = {
    supported() {
      return typeof window.PublicKeyCredential !== 'undefined' && Boolean(navigator.credentials);
    },
    async register() {
      const options = await post({ step: 'register-options' });
      const credential = await navigator.credentials.create({
        publicKey: publicKeyRequest(options.publicKey)
      });
      if (!credential) throw new Error('Touch ID or Face ID was cancelled.');
      return post({ step: 'register', challengeId: options.challengeId, credential: credentialJSON(credential) });
    },
    async login() {
      const options = await post({ step: 'login-options' });
      const credential = await navigator.credentials.get({
        publicKey: publicKeyRequest(options.publicKey)
      });
      if (!credential) throw new Error('Touch ID or Face ID was cancelled.');
      return post({ step: 'login', challengeId: options.challengeId, credential: credentialJSON(credential) });
    },
    friendly
  };
})();
