// txEncoder.js
const BigNumber = require('bignumber.js');

const Encode = {
    // Encode Simple Token Issue Transaction
     encodeActivateTradeLayer(params) {
        // Assuming params has a txid
        return params.code;
    },

    // Encode Token Issue Transaction
    encodeTokenIssue(params) {
        const payload = [
            params.initialAmount.toString(36),
            params.ticker,
            params.whitelists.map(val => val.toString(36)).join(','),
            params.managed ? '1' : '0',
            params.backupAddress,
            params.nft ? '1' : '0'
        ];
        return payload.join(',');
    },

    // Encode Send Transaction
    encodeSend(params) {
        if (params.sendAll) {
            // Handle sendAll case
            return `1;${params.address}`;
        } else if (Array.isArray(params.propertyId) && Array.isArray(params.amount)) {
            // Handle multi-send
            const payload = [
                '0', // Not sendAll
                '', // Address is omitted for multi-send
                params.propertyId.map(id => id.toString(36)).join(','),
                params.amount.map(amt => amt.toString(36)).join(',')
            ];
            return payload.join(';');
        } else {
            // Handle single send
            console.log('encoding single send amount '+params.amount + 'encoded '+params.amount.toString(36))
            const payload = [
                '0', // Not sendAll
                params.address,
                params.propertyId.toString(36),
                params.amount.toString(36)
            ];
            return payload.join(';');
        }
    },



    encodeTradeTokenForUTXO: (params) => {
        const payload = [
            params.propertyId.toString(36),
            params.amount.toString(36),
            params.columnA,
            params.satsExpected.toString(36),
            params.tokenOutput,
            params.payToAddress
        ];
        return payload.join(',');
    },

    // Encode Commit Token Transaction
    encodeCommit: (params) => {
        const payload = [
            params.propertyId.toString(36),
            params.amount.toString(36),
            params.channelAddress
        ];
        return payload.join(',');
    },

    // Encode On-chain Token for Token Transaction
    encodeOnChainTokenForToken: (params) => {
        console.log('encoding token trade ' + JSON.stringify(params));
        const amountOffered = new BigNumber(params.amountOffered).times(1e8).toNumber(); // Multiply by 100 million
        const amountExpected = new BigNumber(params.amountExpected).times(1e8).toNumber(); // Multiply by 100 million
        const payload = [
            params.propertyIdOffered.toString(36),
            params.propertyIdDesired.toString(36),
            amountOffered.toString(36),
            amountExpected.toString(36),
            params.stop ? '1' : '0',
            params.post ? '1' : '0'
        ];
        return payload.join(',');
    },

   
    // Encode function
    encodeCancelOrder: (params) => {
        let encodedTx = params.isContract;

        if (params.isContract) {
            // Encode contract cancellation with a single property ID
            encodedTx += `,${params.contractId.toString(36)},${params.cancelAll ? 1 : 0}`;
        } else {
            // Encode token cancellation with two property IDs
            encodedTx += `,${params.offeredPropertyId.toString(36)},${params.desiredPropertyId.toString(36)},${params.cancelAll ? 1 : 0}`;
        }

        let priceEncoded
        // Encode optional price if provided
        if (params.cancelParams && params.cancelParams.price !== undefined) {
            if(params.isContract==0||params.isContract==false){
                priceEncoded = new BigNumber(params.cancelParams.price).times(8).toString(36); // Encode and multiply by 8
            }else if(params.isContract==1||params.isContract==true){
               priceEncoded = params.cancelParams.price.toString(36);
            }

            encodedTx += `,${priceEncoded}`;
            encodedTx += `,${params.cancelParams.side.toString(36)}`;
        }

        // Encode cancel parameters
        if (params.cancelParams && params.cancelParams.txid) {
            encodedTx += `,${params.cancelParams.txid}`;
        }

        return encodedTx;
    },



    // Encode Create Whitelist Transaction
    encodeCreateWhitelist: (params) => {
        const payload = [
            params.backupAddress,
        ];
        return payload.join(',');
    },

    // Encode Update Whitelist Admin Transaction
    encodeUpdateAdmin: (params) => {
        const payload = [
            params.newAddress,
            params.whitelist ? '1' : '0',
            params.oracle ? '1' : '0',
            params.token ? '1' : '0',
            params.id.toString(36),
        ];
        return payload.join(',');
    },


    // Encode Issue Attestation Transaction
    encodeIssueOrRevokeAttestation: (params) => {
        const payload = [
            params.revoke,
            params.id,
            params.targetAddress,
        ];
        return payload.join(',');
    },

    // Encode Revoke Attestation Transaction
    encodeAMMPool: (params) => {
        const payload = [
            params.isRedeem, 
            params.isContract, 
            params.id, 
            params.amount, 
            params.id2, 
            params.amount2,
        ];
        return payload.join(',');
    },

    // ... Continue with the rest of the transaction types ...

    // Example for Encode Create Oracle Transaction
    encodeCreateOracle: (params) => {
        const payload = [
            params.ticker,
            params.url,
            params.backupAddress,
            params.whitelists.map(whitelist => whitelist.toString(36)).join(','),
            params.lag.toString(36),
        ];
        return payload.join(',');
    },

    // Encode Grant Managed Token Transaction
    encodeGrantManagedToken:(params) => {
      const payload = [
        params.propertyid.toString(36),
        params.amountGranted.toString(36),
        params.addressToGrantTo,
      ];
      return payload.join(',');
    },

    // Encode Redeem Managed Token Transaction
    encodeRedeemManagedToken:(params) => {
      const payload = [
        params.propertyid.toString(36),
        params.amountGranted.toString(36),
        params.addressToGrantTo,
      ];
      return payload.join(',');
    },

    // Encode Publish Oracle Data Transaction
    encodePublishOracleData:(params) => {
      const payload = [
        params.oracleid.toString(36),
        params.price.toString(36),
      ];
      if (params.high !== undefined) {
        payload.push(params.high.toString(36));
      }
      if (params.low !== undefined) {
        payload.push(params.low.toString(36));
      }
      if (params.close !== undefined) {
        payload.push(params.close.toString(36));
      }
      return payload.join(',');
    },

    // Encode Update Oracle Admin Transaction
    encodeUpdateOracleAdmin:(params) => {
      return params.newAddress;
    },

    // Encode Close Oracle Transaction
    encodeCloseOracle() {
      return ''; // No parameters
    },

     // Encode Create Future Contract Series Transaction
    encodeCreateFutureContractSeries: (params) => {
        const payload = [
            params.native ? '1' : '0',
            params.underlyingOracleId.toString(36),
            params.onChainData.map(data => `${data[0].toString(36)}:${data[1].toString(36)}`).join(';'),
            params.notionalPropertyId.toString(36),
            params.notionalValue.toString(36),
            params.collateralPropertyId.toString(36),
            params.leverage,
            params.expiryPeriod !== undefined ? params.expiryPeriod.toString(36) : '0',
            params.series.toString(36),
            params.inverse ? '1' : '0',
            params.fee !== undefined ? params.fee ? '1' : '0' : '0'
        ];
        return payload.join(',');
    },

    // Encode Exercise Derivative Transaction
    encodeExerciseDerivative:(params) => {
      const payload = [
        params.derivativeContractId.toString(36),
        params.amount.toString(36),
      ];
      return payload.join(',');
    },

    // Encode Trade Contract On-chain Transaction
    encodeTradeContractOnchain: (params) => {
        const payload = [
            params.contractId.toString(36),
            params.price.toString(36),
            params.amount.toString(36),
            params.side ? '1' : '0',
            params.insurance ? '1' : '0',
            params.reduce ? '1':'0',
            params.post ? '1':'0',
            params.stop ? '1':'0'
        ];
        return payload.join(',');
    },

    // Encode Trade Contract in Channel Transaction
    encodeTradeContractChannel: (params) => {
        const payload = [
            params.contractId.toString(36),
            params.price.toString(36),
            params.amount.toString(36),
            params.columnAIsSeller ? '1' : '0',
            params.expiryBlock.toString(36),
            params.insurance ? '1' : '0',
        ];
        return payload.join(',');
    },

    // Encode Trade Tokens in Channel Transaction
    encodeTradeTokensChannel: (params) => {
        const payload = [
            params.propertyId1.toString(36),
            params.propertyId2.toString(36),
            params.amountOffered1.toString(36),
            params.amountDesired2.toString(36),
            params.columnAIsOfferer ? '1':'0',
            params.expiryBlock.toString(36),
        ];
        return payload.join(',');
    },

    // Encode Withdrawal Transaction
    encodeWithdrawal: (params) => {
        const withdrawAll = params.withdrawAll
        const propertyIds = params.propertyId.toString(36)/*.map(id => id.toString(36)).join(';')*/;
        const amounts = params.amount.toString(36)/*.map(amount => amount.toString(36)).join(';')*/;
        const column = params.column //0 is A, 1 is B
        return [withdrawAll, propertyIds, amounts, column, params.channelAddress].join(',');
    },

    // Encode Transfer Transaction
    encodeTransfer: (params) => {
        const propertyIds = params.propertyIds.map(id => id.toString(36)).join(';');
        const amounts = params.amounts.map(amount => amount.toString(36)).join(';');
        return [propertyIds, amounts, params.channelAddress].join(',');
    },

    // Encode Settle Channel PNL Transaction
    encodeSettleChannelPNL: (params) => {
        const payload = [
            params.txidNeutralized,
            params.contractId.toString(36),
            params.amountCancelled.toString(36),
            params.propertyId.toString(36),
            params.amountSettled.toString(36),
            params.close ? '1' : '0',
            params.propertyId2 ? params.propertyId2.toString(36) : '0',
            params.amountDelivered ? params.amountDelivered.toString(36) : '0',
        ];
        return payload.join(',');
    },

    // Encode Mint Synthetic Transaction
    encodeMintSynthetic: (params) => {
        const payload = [
            params.propertyIdUsed.toString(36),
            params.contractIdUsed.toString(36),
            params.amount.toString(36),
        ];
        return payload.join(',');
    },

    // Encode Redeem Synthetic Transaction
    encodeRedeemSynthetic: (params) => {
        const payload = [
            params.propertyIdUsed.toString(36),
            params.contractIdUsed.toString(36),
            params.amount.toString(36),
        ];
        return payload.join(',');
    },

    // Encode Pay to Tokens Transaction
    encodePayToTokens: (params) => {
        const payload = [
            params.propertyIdTarget.toString(36),
            params.propertyIdUsed.toString(36),
            params.amount.toString(36),
        ];
        return payload.join(',');
    },

    // Encode Create Option Chain Transaction
    encodeCreateOptionChain: (params) => {
        const payload = [
            params.contractSeriesId.toString(36),
            params.strikePercentInterval.toString(36),
            params.europeanStyle ? '1' : '0',
        ];
        return payload.join(',');
    },

    // Encode Trade Bai Urbun Transaction
    encodeTradeBaiUrbun: (params) => {
        const payload = [
            params.propertyIdDownPayment.toString(36),
            params.propertyIdToBeSold.toString(36),
            params.price.toString(36),
            params.amount.toString(36),
            params.expiryBlock.toString(36),
            params.tradeExpiryBlock.toString(36),
        ];
        return payload.join(',');
    },

    // Encode Trade Murabaha Transaction
    encodeTradeMurabaha: (params) => {
        const payload = [
            params.propertyIdDownPayment.toString(36),
            params.downPaymentPercent.toString(36),
            params.propertyIdToBeSold.toString(36),
            params.price.toString(36),
            params.amount.toString(36),
            params.expiryBlock.toString(36),
            params.installmentInterval.toString(36),
            params.tradeExpiryBlock.toString(36),
        ];
        return payload.join(',');
    },

    // Encode Issue Invoice Transaction
    encodeIssueInvoice: (params) => {
        const payload = [
            params.propertyIdToReceivePayment.toString(36),
            params.amount.toString(36),
            params.dueDateBlock.toString(36),
            params.optionalPropertyIdCollateral ? params.optionalPropertyIdCollateral.toString(36) : '0',
            params.receivesPayToToken ? '1' : '0',
        ];
        return payload.join(',');
    },

    // Encode Batch Move Zk Rollup Transaction
    encodeBatchMoveZkRollup: (params) => {
        // Assuming params.payments is an array of payment objects
        const paymentsPayload = params.payments.map(payment => {
            const paymentDetails = [
                payment.fromAddress,
                payment.propertyIds.map(id => id.toString(36)).join(':'),
                payment.amounts.map(amt => amt.toString(36)).join(':'),
                payment.toAddress,
                payment.sentPropertyIds.map(id => id.toString(36)).join(':'),
                payment.sentAmounts.map(amt => amt.toString(36)).join(':'),
            ];
            return paymentDetails.join(',');
        }).join(';');
        const payload = [
            params.proof,
            paymentsPayload,
            JSON.stringify(params.miscLogic),
            JSON.stringify(params.miscData),
        ];
        return payload.join('|');
    },

    // Encode Publish New Transaction Type
    encodePublishNewTx: (params) => {
        return params.ordinalRevealJSON; // Assuming this is a JSON string
    },

    // Encode Create Derivative of LRC20 or RGB
    encodeColoredCoin: (params) => {
        const payload = [
            params.lrc20TokenSeriesId1.toString(36),
            params.lrc20TokenSeriesId2.toString(36),
            params.rgb ? '1' : '0',
        ];
        return payload.join(',');
    },

    // Encode Register OP_CTV Covenant
    encodeRegisterOPCTVCovenant: (params) => {
        const payload = [
            params.redeem,
            params.txid,
            params.associatedPropertyId1 ? params.associatedPropertyId1.toString(36) : '0',
            params.associatedPropertyId2 ? params.associatedPropertyId2.toString(36) : '0',
            params.covenantType.toString(36),
        ];
        return payload.join(',');
    },

    // Encode cross TL chain bridging tx
    encodeCrossLayerBridge: (params) => {
        const payload = [
            params.propertyId.toString(36),
            params.amount.toString(36),
            params.destinationAddr
        ];
        return payload.join(',');
    }

}

module.exports = Encode;