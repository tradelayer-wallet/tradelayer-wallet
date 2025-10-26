const axios = require('axios');

module.exports = {
  createPayload(propertyId, amount) {
    return axios.post('/tl_createpayload_commit_tochannel', { propertyId, amount })
      .then(res => res.data)
      .catch(err => { throw new Error(err.response.data.error); });
  },

  validateAddress(address) {
    return axios.post('/tl_validateaddress', { address })
      .then(res => res.data)
      .catch(err => { throw new Error(err.response.data.error); });
  },

  sendTx(signedTx) {
    return axios.post('/tl_sendtx', { signedTx })
      .then(res => res.data)
      .catch(err => { throw new Error(err.response.data.error); });
  },

  signPsbt(keypair, psbtHex) {
    return axios.post('/tl_signPsbt', { wif: keypair.wif, psbtHex })
      .then(res => res.data)
      .catch(err => { throw new Error(err.response.data.error); });
  }
};
