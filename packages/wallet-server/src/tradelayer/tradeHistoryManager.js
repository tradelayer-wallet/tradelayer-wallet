const database = require('./db.js')
const BigNumber = require('bignumber.js');

class TradeHistory {
  constructor() {
    this.tradeHistoryDb = database.getDatabase('tradeHistory');
  }

  async loadTradeHistory(contractId) {
    let key = { "key": "contract-" + contractId }
    console.log('key to load trades ' +JSON.stringify(key))
    return this.tradeHistoryDb.findAsync(key);
  }

  async getTradeHistoryForAddress(address,contractId) {
    console.log('about to call load history for contract '+contractId)
    const tradeHistory = await this.loadTradeHistory(contractId);
    //console.log('loading the whole trade history for everything ' +JSON.stringify(tradeHistory))
    return tradeHistory.filter((trade) =>
      [trade.trade.buyerAddress, trade.trade.sellerAddress].includes(address)
    );
  }

  async getPositionHistoryForContract(address, contractId) {
    //console.log('about to call trade history for contract '+contractId)
    const addressTradeHistory = await this.getTradeHistoryForAddress(address,contractId);
    addressTradeHistory.sort((a, b) => a.blockHeight - b.blockHeight);

    //console.log('filtered trade history for address  '+address+  '  ' +JSON.stringify(addressTradeHistory))
    const positionHistory = [];
    var position = 0

    for (const trade of addressTradeHistory) {
      //console.log(JSON.stringify(trade))
      if (trade.trade.contractId === contractId) {
        if(trade.trade.sellerAddress==address){
          trade.trade.amount *= -1
        }
        // Check if the trade is a close
        const isClose = Math.abs(position) > Math.abs(position + trade.trade.amount);
        //console.log(Math.abs(position) + ' '+ Math.abs(position +trade.trade.amount))
        position = position + trade.trade.amount

        const snapshot = {
          amount: position,
          price: trade.trade.price,
          blockHeight: trade.blockHeight,
          isClose: isClose
        };
        //console.log(snapshot)
        positionHistory.push(snapshot);

      }
    }
    //console.log(positionHistory)
    return positionHistory;
  }

  async getTxIdsForContract(address, contractId, action) {
    const addressTradeHistory = await this.getTradeHistoryForAddress(address);
    const txIds = [];

    for (const trade of addressTradeHistory) {
      if (trade.trade.contractId === contractId && trade.trade.buyerAddress === address) {
        txIds.push({
          txId: trade.trade.buyerTx, 
          blockHeight: trade.blockHeight,
        });
      }else if(trade.trade.contractId === contractId && trade.trade.sellerAddress === address){
        txIds.push({
          txId: trade.trade.sellerTx, 
          blockHeight: trade.blockHeight,
        });
      }
    }

    return txIds;
  }
async getCategorizedTrades(address, contractId) {
    const trades = await this.getTradeHistoryForAddress(address, contractId);

    let openTrades = [];
    let closeTrades = [];

    for (let i = 0; i < trades.length; i++) {
        const currentTrade = trades[i].trade;
        console.log('checking currentTrade'+JSON.stringify(currentTrade))
        let individualTrade = {
            address: '',
            contractId: currentTrade.contractId,
            price: currentTrade.price,
            amount: 0,
            block: currentTrade.block,
            fullyClosesPosition: false,
        };

        if (currentTrade.buyerClose == 0&&currentTrade.buyerAddress==address) {
            individualTrade.amount = currentTrade.amount;
            individualTrade.address = currentTrade.buyerAddress;
            openTrades.push(individualTrade);
        } else if((currentTrade.buyerClose>0||currentTrade.buyerClose==null)&&currentTrade.buyerAddress==address){
            individualTrade.amount = currentTrade.buyerClosed;
            individualTrade.address = currentTrade.buyerAddress;
            individualTrade.fullyClosesPosition = currentTrade.buyerFullClose;
            closeTrades.push(individualTrade);
            if (currentTrade.flipLong > 0) {
                // flip trade
                console.log('flip long before ajustment '+JSON.stringify(individualTrade))
                individualTrade.amount = currentTrade.flipLong;
                individualTrade.address = currentTrade.buyerAddress;
                individualTrade.fullyClosesPosition = true;
                console.log('flip long after adjustment '+JSON.stringify(individualTrade))
                openTrades.push(individualTrade);
            }
        }

        if (currentTrade.sellerClose == 0&&currentTrade.sellerAddress==address) {
            individualTrade.amount = currentTrade.amount*-1;
            individualTrade.address = currentTrade.sellerAddress;
            openTrades.push(individualTrade);
        } else if((currentTrade.sellerClose>0||currentTrade.sellerClose==null)&&currentTrade.sellerAddress==address){
            individualTrade.amount = currentTrade.sellerClosed*-1;
            individualTrade.address = currentTrade.sellerAddress;
            individualTrade.fullyClosesPosition = currentTrade.sellerFullClose;
            closeTrades.push(individualTrade);
            if (currentTrade.flipShort> 0) {
                // flip trade
                individualTrade.amount = currentTrade.sellerClosed*-1;
                individualTrade.address = currentTrade.sellerAddress;
                individualTrade.fullyClosesPosition = true;
                openTrades.push(individualTrade);
            }
        }
    }

    // Sort open and close trades by block height
    openTrades.sort((a, b) => a.block - b.block);
    closeTrades.sort((a, b) => a.block - b.block);

    const categorizedTrades = {
        openTrades: openTrades,
        closeTrades: closeTrades,
    };

    return categorizedTrades;
}


computeAverageEntryPrices(openTrades) {
    let sum = new BigNumber(0);
    let count = new BigNumber(0);

    for (let i = 0; i < openTrades.length; i++) {
        const trade = openTrades[i];
        const price = new BigNumber(trade.price);
        const amount = new BigNumber(trade.amount);

        sum = sum.plus(price.times(amount.abs()));;
        count = count.plus(amount.abs());
    }

    const avgEntryPrice = count.isGreaterThan(0) ? sum.dividedBy(count) : new BigNumber(0);
    return avgEntryPrice.toNumber();
}


async trackPositionHistory(address, contractId) {
    const { openTrades, closeTrades } = await this.getCategorizedTrades(address, contractId);
    //console.log('open trades for ' + address + ' ' + JSON.stringify(openTrades) + ' close trades ' + JSON.stringify(closeTrades));

    // Sort open and close trades by block height
    const sortedOpenTrades = openTrades.sort((a, b) => a.blockHeight - b.blockHeight);
    const sortedCloseTrades = closeTrades.sort((a, b) => a.blockHeight - b.blockHeight);

    // Break up opening trades based on consecutive closing trades
    const separatedOpenTrades = this.breakUpOpeningTrades([...sortedOpenTrades], sortedCloseTrades);
    //console.log('separatedOpenTrades ' + JSON.stringify(separatedOpenTrades));
    const positionHistory = [];

    for (const openTradesSubset of separatedOpenTrades) {
        // Compute the average entry price for the current subset
        const avgEntryPrice = this.computeAverageEntryPrices(openTradesSubset);
        //console.log('avgEntryPrice for address ' + address + ' ' + avgEntryPrice);

        let position = new BigNumber(0);  // Reset position for each subset
        let prevBlockHeight = 0;

      openTradesSubset.forEach((trade) => {
          const blockHeight = trade.block;

          if (avgEntryPrice !== undefined) {
              const entryPrice = avgEntryPrice;
              const fullyClosesPosition = sortedCloseTrades.some(
                  (closeTrade) => closeTrade.block === blockHeight && closeTrade.fullyClosesPosition
              );

              // Check if it's a closing trade
              if (fullyClosesPosition) {
                  // Calculate realized PNL for the closing trade
                  const pnl = entryPrice.minus(trade.price).times(trade.amount);
                  console.log('Realized PNL: ' + pnl.toNumber());
                  
                  // Adjust position based on the closing trade
                  position = position.plus(pnl);
              } else {
                  // It's an opening trade, update position accordingly
                  position = position.plus(trade.amount);
              }

              if (blockHeight !== prevBlockHeight) {
                  // If the block height changes, add a new entry to position history
                  positionHistory.push({
                      blockHeight,
                      position: position.toNumber(),
                      avgEntryPrice: entryPrice,
                      fullyClosesPosition,
                  });

                  // Reset the position for the new block height
                  position = new BigNumber(0);
              }

              if (!fullyClosesPosition) {
                  // Only update if the trade doesn't fully close the position
                  trade.position = position.toNumber();
              }
          }
      })
    }

    return positionHistory;
}




breakUpOpeningTrades(openTrades, closeTrades) {
    const separatedOpenTrades = [];
    let currentBlockHeight = null;
    let currentOpenTrades = [];
    console.log('open and close trades in breakUpOpeningTrades ' + JSON.stringify(openTrades) + ' ' + JSON.stringify(closeTrades));
    
    let closeTrade = null; // Initialize closeTrade

    for (const trade of openTrades) {
        const blockHeight = trade.blockHeight;

        if (currentBlockHeight !== blockHeight) {
            // Check for consecutive closing trades
            if (closeTrade && closeTrade.blockHeight === blockHeight - 1) {
                console.log('close trade blockHeight ' + closeTrade.blockHeight + ' ' + (blockHeight - 1));
            }

            const consecutiveCloses = closeTrades.filter(
                close => close.blockHeight === blockHeight - 1
            );

            if (consecutiveCloses.length > 0) {
                // Consecutive closing trade found, start a new array for open trades
                separatedOpenTrades.push([...currentOpenTrades]);
                currentOpenTrades = [];
            }
        }

        currentOpenTrades.push(trade);
        currentBlockHeight = blockHeight;
    }

    // Add the last set of open trades to the result array
    separatedOpenTrades.push([...currentOpenTrades]);

    return separatedOpenTrades;
}




async calculateLIFOEntry(address, amount, contractId) {
      const categorizedTrades = await this.getCategorizedTrades(address, contractId);
      console.log('open trades ' +JSON.stringify(categorizedTrades.openTrades));

      // Sort trades by block height in descending order (LIFO)
      categorizedTrades.openTrades.sort((a, b) => b.blockHeight - a.blockHeight);

      // Calculate the LIFO entry based on the sorted trades
      let remainingAmount = Math.abs(amount);
      let totalCost = 0;
      const blockTimes = [];

      for (const trade of categorizedTrades.openTrades) {
        const tradeAmount = Math.abs(trade.tradedAmount);
        const tradeCost = tradeAmount * trade.price;
        console.log('old open trade ' +JSON.stringify(trade)+ ' '+totalCost)
        if (tradeAmount <= remainingAmount) {
          // Fully cover the remaining amount with the current trade
          totalCost += tradeCost;
          remainingAmount -= tradeAmount;
          blockTimes.push(trade.blockHeight); // Add block time of the closing trade
        } else {
          // Partially cover the remaining amount with the current trade
          totalCost += (remainingAmount / tradeAmount) * tradeCost;
          remainingAmount = 0;
          blockTimes.push(trade.blockHeight); // Add block time of the closing trade
        }

        if (remainingAmount === 0) {
          // Fully covered the given amount
          break;
        }
      }

      // Return an object with total cost and block times
      return {
        totalCost,
        blockTimes,
      };
    }

    /**
     * Save PNL data to the trade history database.
     *
     * @param {number} currentBlockHeight - The current block height.
     * @param {string} contractId - The contract ID associated with the trade.
     * @param {number} accountingPNL - The accounting PNL value.
     * @param {string} buyerAddress - The address of the buyer.
     * @param {number} orderAmount - The amount in the buy order.
     * @param {number} orderPrice - The price in the buy order.
     * @param {string} collateralPropertyId - The ID of the collateral property.
     * @param {string} timestamp - The timestamp of the trade.
     * @param {string} buyerTx - The buyer's transaction ID.
     * @param {number} settlementPNL - The settlement PNL value.
     * @param {number} reduction - The reduction value.
     * @param {object} LIFO - The LIFO data object.
     * @returns {Promise<string>} - A Promise that resolves to the key under which the data is saved.
     */
    async savePNL(params) {
      // Assuming tradeHistoryManager is an instance of a database manager or similar
      // Adjust the following code based on your actual database handling implementation

      // Assuming rPNL-address-contractId-block is the key structure you want to use
      const key = `rPNL-${params.address}-${params.contractId}-${params.height}`;
      console.log('preparing to save PNL '+JSON.stringify(params))

      // Assuming tradeHistoryManager.save is a method to save data to the database
      await this.save(key, params);

      // Optionally, you can return the key or any other relevant information
      return key;
    }

     /**
       * Save data to the trade history database.
       *
       * @param {string} key - The key under which to save the data.
       * @param {object} data - The data to be saved.
       * @returns {Promise<void>} - A Promise that resolves once the data is saved.
       */
      async save(key, data) {
        try {
          const db = database.getDatabase('tradeHistory');
          const value = JSON.stringify(data);

          console.log(`updating tradeHistoryDB with ${value}`);

          // Save the data to the database
          await db.updateAsync({ _id: key }, { $set: { value } }, { upsert: true });

          console.log(`tradeHistoryDB saved successfully.`);
        } catch (err) {
          console.error(`Error saving tradeHistory rPNL:`, err);
          throw err;
        }
      }

    async displayPositionHistory(address, contractId) {
      const positionHistory = this.getPositionHistoryForContract(address, contractId);
      console.log(`Position History for Address ${address} and Contract ID ${contractId}:`);
      console.table(positionHistory);
    }
}

module.exports = TradeHistory;