// txDecoder.js
const BigNumber = require('bignumber.js');

const Decode = {
   // Decode Activate TradeLayer Transaction
    decodeActivateTradeLayer: (payload) => {
    return { txTypeToActivate: payload };
    },

    // Decode Token Issue Transaction
    decodeTokenIssue: (payload) => {
        const parts = payload.split(',');
        return {
            initialAmount: parseInt(parts[0], 36),
            ticker: parts[1],
            whitelists: parts[2].split(';').map(val => parseInt(val, 36)),
            managed: parts[3] === '1',
            backupAddress: parts[4],
            nft: parts[5] === '1'
        };
    },

    // Decode Send Transaction
    decodeSend: (payload) => {
      //console.log('send payload to decode '+ payload)
        const parts = payload.split(';');
        const sendAll = parts[0] === '1';
        const address = parts[1];

        if (sendAll) {
            return { sendAll:sendAll, address:address };
        } else if (parts.length === 4) {
            // Single send
            const propertyId = parseInt(parts[2], 36); // Decode propertyId from base36
            const amount = parseInt(parts[3], 36); // Decode amount from base36
            //console.log('decoding single send amount ' +amount + ' '+ parts[3])
            return { sendAll: sendAll, address:address, propertyIds:propertyId, amounts:amount };
        } else {
            // Multi-send
            const propertyIds = parts[2].split(',').map(id => parseInt(id, 36));
            const amounts = parts[3].split(',').map(amt => parseInt(amt, 36));
            return { sendAll:sendAll, propertyIds: propertyIds.map((id, index) => ({ propertyId: id, amounts: amounts[index] })) };
        }
    },


    // Decode Trade Token for UTXO Transaction
    decodeTradeTokenForUTXO: (payload) => {
        const parts = payload.split(',');
        return {
            propertyId: parseInt(parts[0], 36),
            amount: parseInt(parts[1], 36),
            columnA: parts[2]==="1",
            satsExpected: parseInt(parts[3], 36),
            tokenOutput: parts[4],
            payToAddress: parts[5]
        };
    },

    // Decode Commit Token Transaction
    decodeCommitToken: (payload) => {
        const parts = payload.split(',');
        return {
            propertyId: parseInt(parts[0], 36),
            amount: parseInt(parts[1], 36),
            channelAddress: parts[2]
        };
    },

    // Decode On-chain Token for Token Transaction
    decodeOnChainTokenForToken: (payload) => {
        const parts = payload.split(',');
        return {
            propertyIdOffered: parseInt(parts[0], 36),
            propertyIdDesired: parseInt(parts[1], 36),
            amountOffered: new BigNumber(parts[2], 36).div(1e8).toNumber(), // Divide by 100 million
            amountExpected: new BigNumber(parts[3], 36).div(1e8).toNumber(), // Divide by 100 million
            stop: parts[4] === "1",
            post: parts[5] === "1",
        };
    },

    decodeCancelOrder:(encodedTx) =>{
        const elements = encodedTx.split(',');

        // Decode the first element
        let isContract = elements[0];
        const cancelParams = {};
        //console.log('decoding cancel, isContract'+isContract)
        // Determine if it's a contract cancellation based on the first element
        let offeredPropertyId
        let desiredPropertyId
        let cancelAll
        if (isContract==1) {
            isContract=true
            offeredPropertyId = parseInt(elements[1], 36);
            desiredPropertyId = null;
            cancelAll = parseInt(elements[2], 36);

            // Check if elements[3] exists before accessing its length property
            if (elements[3] && elements[3].length > 20) {
                cancelParams.txid = elements[3];
            } else {
                cancelParams.price = elements[3];
                cancelParams.side = elements[4];
            }
        } else {
            isContract=false
            offeredPropertyId = parseInt(elements[1], 36);
            desiredPropertyId = isContract ? null : parseInt(elements[2], 36);
            cancelAll = parseInt(elements[3], 36);

            // Check if elements[4] exists before accessing its length property
            if (elements[4] && elements[4].length > 20) {
                // It's a non-contract cancellation with additional parameters
                cancelParams.txid = elements[4];
            } else {
                const priceDecoded = new BigNumber(elements[3]).dividedBy(8).toNumber(); // Decode and divide by 8
                cancelParams.price = priceDecoded;   cancelParams.side = elements[5];
                if(cancelParams.side==1){
                  cancelParams.side=true
                }else{
                  cancelParams.side=false
                }
            }
        }

        // Decode the remaining elements

        return {
            isContract,
            offeredPropertyId,
            desiredPropertyId,
            cancelAll,
            cancelParams
        };
    },



    // Decode Create Whitelist Transaction
    decodeCreateWhitelist: (payload) => {
        const parts = payload.split(',');
        return {
            backupAddress: parts[0],
            whitelistId: parseInt(parts[1], 36)
        };
    },

    // Decode Update Admin Transaction
    decodeUpdateAdmin: (payload) => {
        const parts = payload.split(',');
        return {
            newAddress: parts[0],
            whitelist: parts[1] === '1',
            oracle: parts[2] === '1',
            token: parts[3] === '1',
            id: parseInt(parts[4], 36)
        };
    },

    // Decode Issue Attestation Transaction
    decodeIssueOrRevokeAttestation: (payload) => {
        const parts = payload.split(',');
        return {
            revoke: parts[0]===1,
            id: parseInt(parts[1],36),
            targetAddress: parts[3]
        };
    },

    // Decode Revoke Attestation Transaction
    decodeAMMPool: (payload) => {
        const parts = payload.split(',');
        return {
            isRedeem: parts[0] === '1',
            isContract: parts[1] === '1',
            id: parseInt(parts[2],36),
            amount: parseInt(parts[3],36),
            id2: parseInt(parts[4],36),
            amount2: parseInt(parts[5],36)
        };
    },

    // Decode Grant Managed Token Transaction
    decodeGrantManagedToken: (payload) => {
        const parts = payload.split(',');
        return {
            propertyId: parseInt(parts[0],36),
            amountGranted: parseInt(parts[1], 36),
            addressToGrantTo: parts[2]
        };
    },

    // Decode Redeem Managed Token Transaction
    decodeRedeemManagedToken: (payload) => {
      const parts = payload.split(',');
        return {
            propertyId: parseInt(parse[0],36),
            amountDestroyed: parseInt(parts[1], 36)
        };
    },

    // Decode Create Oracle Transaction
    decodeCreateOracle: (payload) => {
        const parts = payload.split(',');
        return {
            ticker: parts[0],
            url: parts[1],
            backupAddress: parts[2],
            whitelists: parts[3].split(';').map(val => parseInt(val, 36)),
            lag: parseInt(parts[4], 36)
        };
    },

    // Decode Publish Oracle Data Transaction
    decodePublishOracleData: (payload) => {
        const parts = payload.split(',');
        const data = {
            oracleId: parseInt(parts[0], 36), // Decode oracleId as the first part
            price: parseInt(parts[1], 36)     // Adjust indices for other parts
        };
        if (parts[2]) {
            data.high = parseInt(parts[2], 36);
        }
        if (parts[3]) {
            data.low = parseInt(parts[3], 36);
        }
        if (parts[4]) {
            data.close = parseInt(parts[4], 36);
        }
        return data;
    },

    // Decode Close Oracle Transaction
    decodeCloseOracle() {
      return {}; // No parameters
    },

    decodeCreateFutureContractSeries: (payload) => {
        const parts = payload.split(',');

        // Check if the contract is native or not
        const isNative = parts[0] === '1';

        // Initialize onChainDataParts
        let onChainDataParts = [];

        // Parse onChainData only if the contract is not native
        if (!isNative) {
            onChainDataParts = parts[2].split(';').map(pair => 
                pair.split(':').map(val => val ? parseInt(val, 36) : null)
            );
        }

        return {
            native: isNative,
            underlyingOracleId: parseInt(parts[1], 36),
            onChainData: onChainDataParts,
            notionalPropertyId: parseInt(parts[3], 36),
            notionalValue: parseFloat(parts[4]), // Assuming notionalValue should be a float
            collateralPropertyId: parseInt(parts[5], 36),
            leverage: parseFloat(parts[6]), // Assuming leverage should be a float
            expiryPeriod: parts[7] ? parseInt(parts[7], 36) : null,
            series: parts[8] ? parseInt(parts[8], 36) : null,
            inverse: parts[9] === '1',
            fee: parts[10] === '1'
        };
    },


    // Decode Exercise Derivative Transaction
    decodeExerciseDerivative(payload) {
      const [derivativeContractId, amount] = payload.split(',');
      return {
        derivativeContractId: parseInt(derivativeContractId, 36),
        amount: parseInt(amount, 36),
      };
    },

   // Decode Trade Contract On-chain Transaction
  decodeTradeContractOnchain: (payload) => {
    const parts = payload.split(',');
    return {
      contractId: parseInt(parts[0], 36),
      price: parseInt(parts[1], 36),
      amount: parseInt(parts[2], 36),
      side: parts[3] === '1',
      insurance: parts[4] === '1',
      reduce: parts[5]==="1",
      post: parts[6]==="1",
      stop: parts[7]==="1"
    };
  },

  // Decode Trade Contract in Channel Transaction
  decodeTradeContractChannel: (payload) => {
    const parts = payload.split(',');
    return {
      contractId: parseInt(parts[0], 36),
      price: parseInt(parts[1], 36),
      amount: parseInt(parts[2], 36),
      columnAIsSeller: parts[3] === '1',
      expiryBlock: parseInt(parts[4], 36),
      insurance: parts[5] === '1',
    };
  },

  // Decode Trade Tokens in Channel Transaction
  decodeTradeTokensChannel: (payload) => {
    const parts = payload.split(',');
    return {
      propertyIdOffered: parseInt(parts[0], 36),
      propertyIdDesired: parseInt(parts[1], 36),
      amountOffered: parseInt(parts[2], 36),
      amountDesired: parseInt(parts[3], 36),
      columnAIsOfferer: parts[4] === '1',
      expiryBlock: parseInt(parts[5], 36),
    };
  },

  // Decode Withdrawal Transaction
  decodeWithdrawal: (payload) => {
    const parts = payload.split(',');
    return {
      withdrawAll: parts[0]==="1",
      propertyId: parseInt(parts[1],36),
      amount: parseInt(parts[2],36),
      column: parts[3]==="1",
      channelAddress: parts[4],
    };
  },

  // Decode Transfer Transaction
  decodeTransfer: (payload) => {
    const parts = payload.split(',');
    return {
      propertyIds: parts[0].split(';').map(id => parseInt(id, 36)),
      amounts: parts[1].split(';').map(amount => parseInt(amount, 36)),
      channelAddress: parts[2],
    };
  },

  // Decode Settle Channel PNL Transaction
  decodeSettleChannelPNL: (payload) => {
    const parts = payload.split(',');
    return {
      txidNeutralized: parts[0],
      contractId: parseInt(parts[1], 36),
      amountCancelled: parseInt(parts[2], 36),
      propertyId: parseInt(parts[3], 36),
      amountSettled: parseInt(parts[4], 36),
      close: parts[5] === '1',
      propertyId2: parts[6] ? parseInt(parts[6], 36) : null,
      amountDelivered: parts[7] ? parseInt(parts[7], 36) : null,
    };
  },

  // Decode Mint Synthetic Transaction
  decodeMintSynthetic: (payload) => {
    const parts = payload.split(',');
    return {
      propertyIdUsed: parseInt(parts[0], 36),
      contractIdUsed: parseInt(parts[1], 36),
      amount: parseInt(parts[2], 36),
    };
  },

  // Decode Redeem Synthetic Transaction
  decodeRedeemSynthetic: (payload) => {
    const parts = payload.split(',');
    return {
      propertyIdUsed: parseInt(parts[0], 36),
      contractIdUsed: parseInt(parts[1], 36),
      amount: parseInt(parts[2], 36),
    };
  },

  // Decode Pay to Tokens Transaction
  decodePayToTokens: (payload) => {
    const parts = payload.split(',');
    return {
      propertyIdTarget: parseInt(parts[0], 36),
      propertyIdUsed: parseInt(parts[1], 36),
      amount: parseInt(parts[2], 36),
    };
  },

    decodeBatchMoveZkRollup: (payload) =>{
       return { ordinalRevealJSON: payload };
    },

    // Decode Publish New Transaction Type
    decodePublishNewTx: (payload) => {
        return { ordinalRevealJSON: payload };
    },

    // Decode Create Derivative of LRC20 or RGB
    decodeColoredCoin: (payload) => {
        const parts = payload.split(',');
        return {
            propertyId1: parseInt(parts[0], 36),
            lrc20TokenSeriesId2: parseInt(parts[1], 36),
            rgb: parts[2] === '1'
        };
    },

    // Decode Register OP_CTV Covenant
    decodeOPCTVCovenant: (payload) => {
        const parts = payload.split(',');
        return {
            txid: parts[0],
            associatedPropertyId1: parts[1] ? parseInt(parts[1], 36) : null,
            associatedPropertyId2: parts[2] ? parseInt(parts[2], 36) : null,
            covenantType: parseInt(parts[3], 36),
            redeem: parts[4] === '1' // '1' indicates true, anything else is considered false
        };
    },


    // Decode Mint Colored Coin
    decodeCrossLayerBridge: (payload) => {
        const parts = payload.split(',');
        return {
            propertyId: parseInt(parts[0], 36),
            amount: parseInt(parts[1], 36)
        };
    }

}

// ... continue decoding functions for the rest of the transactions ...

module.exports = Decode