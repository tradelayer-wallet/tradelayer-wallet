// Assuming the LevelDB database is stored at './path_to_margin_db'
const db = require('./db.js');
const BigNumber = require('bignumber.js')
const uuid = require('uuid');


class MarginMap {
    constructor(seriesId) {
        this.seriesId = seriesId;
        this.margins = new Map();
    }

    static async getInstance(contractId) {
        // Load the margin map for the given contractId from the database
        // If it doesn't exist, create a new instance
        const marginMap = await MarginMap.loadMarginMap(contractId);
        return marginMap;
    }

    static async loadMarginMap(seriesId) {
        const key = JSON.stringify({ seriesId });
        //console.log('loading margin map for ' + seriesId);
        // Retrieve the marginMaps database from your Database instance
        const marginMapsDB = db.getDatabase('marginMaps');

        try {
            const doc = await marginMapsDB.findOneAsync({ _id: key });
            if (!doc) {
                // Return a new instance if not found
                console.log('no MarginMap found, spinning up a fresh one');
                return new MarginMap(seriesId);
            }

            //console.log('marginMap parsed from DB ' + JSON.stringify(doc));
            const map = new MarginMap(seriesId);

            // Parse the value property assuming it's a JSON string
            const parsedValue = JSON.parse(doc.value);
            
            if (parsedValue instanceof Array) {
                // Assuming parsedValue is an array
                map.margins = new Map(parsedValue);
            } else {
                console.error('Error parsing margin map value. Expected an array.');
            }

            //console.log('returning a map from the file ' + JSON.stringify(map.margins));
            return map;
        } catch (err) {
            console.error('Error loading margin Map ' + err);
        }
    }


    /*static async loadMarginMap(seriesId) {
        const key = JSON.stringify({ seriesId});
        console.log('loading margin map for '+seriesId)
        // Retrieve the marginMaps database from your Database instance
        const marginMapsDB = db.getDatabase('marginMaps');

        try {
            const doc = await marginMapsDB.findOneAsync({ _id: key });
            if (!doc) {
                // Return a new instance if not found
                console.log('no MarginMap found, spinning up a fresh one')
                return new MarginMap(seriesId);
            }
            console.log('marginMap parsed from DB '+JSON.stringify(doc))
            var map = new MarginMap(seriesId);
            map.margins = new Map(JSON.parse(doc.value));
            console.log('returning a map from the file '+JSON.stringify(map))
            return map;
        } catch (err) {
            console.log('err loading margin Map '+err)
        }
    }*/

    /*initMargin(address, contracts, price) {
        const notional = contracts * price;
        const margin = notional * 0.1;

        this.margins.set(address, {
            contracts,
            margin,
            unrealizedPl: 0
        });

        return margin;
    }*/

    async getAllPositions() {
       
        const allPositions = [];

        for (const [address, position] of this.margins.entries()) {
            allPositions.push({
                address: address,
                contracts: position.contracts,
                margin: position.margin,
                unrealizedPNL: position.unrealizedPNL,
                avgPrice: position.avgPrice
                // Add other relevant fields if necessary
            });
        }

        return allPositions;
    }


// Set initial margin for a new position in the MarginMap
    async setInitialMargin(sender, contractId, totalInitialMargin) {
        //console.log('setting initial margin '+sender, contractId, totalInitialMargin)
        // Check if there is an existing position for the sender
        let position = this.margins.get(sender);

        console.log('setting initial margin position '+JSON.stringify(position))

        if (!position) {
            // If no existing position, initialize a new one
            position = {
                contracts: 0,  // Number of contracts the sender has
                margin: 0      // Total margin amount the sender has posted
            };
        }

        //console.log('margin before '+position.margin)
        // Update the margin for the existing or new position
        position.margin += totalInitialMargin;
        //console.log('margin after '+position.margin)
        // Update the MarginMap with the modified position
        this.margins.set(sender, position);
        //console.log('margin should be topped up '+JSON.stringify(position))
        await this.recordMarginMapDelta(sender, contractId, position.contracts, 0, totalInitialMargin, 0, 0, 'initialMargin')
        // Save changes to the database or your storage solution
        await this.saveMarginMap(true);
        return position
    }

      // add save/load methods
    async saveMarginMap(isMargin) {
        try {
            const key = JSON.stringify({ seriesId: this.seriesId });
            const marginMapsDB = db.getDatabase('marginMaps');
            const value = JSON.stringify([...this.margins]);
            if(isMargin){
                //console.log('updating marginMap with margin '+JSON.stringify(value))
            }else{
                //console.log('updating marginMap after match process '+JSON.stringify(value))
            }
            // Save the margin map to the database
            await marginMapsDB.updateAsync({ _id: key }, { $set: { value } }, { upsert: true });

            //console.log('MarginMap saved successfully.');
        } catch (err) {
            console.error('Error saving MarginMap:', err);
            throw err;
        }
    }


    /*async setInitialMargin(sender, contractId, totalInitialMargin) {
        console.log('setting initial margin ' + sender, contractId, totalInitialMargin);
        // Load the existing margin map
        const existingMap = await MarginMap.loadMarginMap(contractId);
        let position = existingMap.margins.get(sender);

        console.log('setting initial margin position ' + JSON.stringify(position));

        if (!position) {
            // If no existing position, initialize a new one
            position = {
                contracts: 0,  // Number of contracts the sender has
                margin: 0      // Total margin amount the sender has posted
            };
        }

        console.log('margin before ' + position.margin);
        // Update the margin for the existing or new position
        position.margin += totalInitialMargin;
        console.log('margin after ' + position.margin);
        // Update the MarginMap with the modified position
        existingMap.margins.set(sender, position);
        console.log('margin should be topped up ' + JSON.stringify(existingMap.margins));

        // Save changes to the database or your storage solution
        await existingMap.saveMarginMap();
    }*/


    // Update the margin for a specific address and contract
    /*async updateMargin(contractId, address, amount, price, isBuyOrder, inverse) {
            const position = this.margins.get(address) || this.initMargin(address, 0, price);

            // Calculate the required margin for the new amount
            console.log('checking requiredMargin in updateMargin '+JSON.stringify(position)+' amount '+amount +' price '+ price + ' inverse '+inverse)
            const requiredMargin = this.calculateMarginRequirement(amount, price, inverse);

            if (isBuyOrder) {
                // For buy orders, increase contracts and adjust margin
                position.contracts += amount;
                position.margin += requiredMargin;

                // Check for margin maintenance and realize PnL if needed
                this.checkMarginMaintenance(address, contractId);
            } else {
                // For sell orders, decrease contracts and adjust margin
                position.contracts -= amount;
                position.margin -= requiredMargin;

                // Realize PnL if the position is being reduced
                this.realizePnL(address, contractId, amount, price);
            }

            // Ensure the margin doesn't go below zero
            position.margin = Math.max(0, position.margin);

            // Update the margin map
            this.margins.set(address, position);

            // Additional logic to handle margin calls or other adjustments if required
    }*/

    async updateContractBalancesWithMatch(match, channelTrade, close,flip) {
        //console.log('updating contract balances, buyer '+JSON.stringify(match.buyerPosition)+ '  and seller '+JSON.stringify(match.sellerPosition))
        let buyerPosition = await this.updateContractBalances(
            match.buyOrder.buyerAddress,
            match.buyOrder.amount,
            match.tradePrice,
            true,
            match.buyerPosition,
            match.inverse,
            channelTrade,
            close,
            flip,
            match.buyOrder.contractId
        );

        let sellerPosition = await this.updateContractBalances(
            match.sellOrder.sellerAddress,
            match.sellOrder.amount,
            match.tradePrice,
            false,
            match.sellerPosition,
            match.inverse,
            channelTrade,
            close,
            flip,
            match.sellOrder.contractId
        );
        return {bp: buyerPosition, sp: sellerPosition}
    }

    async updateContractBalances(address, amount, price, isBuyOrder,position, inverse, channelTrade, close,flip,contractId) {
        //const position = this.margins.get(address) || this.initMargin(address, 0, price);
        //console.log('updating the above position for amount '+JSON.stringify(position) + ' '+amount + ' price ' +price +' address '+address+' is buy '+isBuyOrder)
        //calculating avg. price
        console.log('inside updateContractBalances '+close +' '+flip+' position '+position.contracts+' avg. price '+position.avgPrice)
        if(close==false&&flip==false){
            if(position.contracts==0){
                if(position.avgPrice==undefined||position.avgPrice==null){
                    console.log('setting avg. price as trade price for new position '+position.avgPrice)
                    position.avgPrice=price
                }else{
                    position.avgPrice=price
                }
            }else{
                console.log('about to call updateAveragePrice '+amount+' '+price+' '+contractId)
                position.avgPrice=this.updateAveragePrice(position,amount,price,contractId)
                console.log('after the avg price function '+position.avgPrice)

            }
        }else if(flip==true){
            //this is the first trade in the new direction of the flip so its price is the avg. entry price
            position.avgPrice=price
        }

        // For buy orders, increase contracts and adjust margin
        // Calculate the new position size and margin adjustment
        let newPositionSize = isBuyOrder ? position.contracts + amount : position.contracts - amount;
        //console.log('new newPositionSize '+newPositionSize + ' address '+ address + ' amount '+ amount + ' isBuyOrder '+isBuyOrder)
        position.contracts=newPositionSize
        
        const ContractList = require('./contractRegistry.js')
        const TallyMap = require('./tally.js')

        //console.log('position now ' + JSON.stringify(position))
        const notionalValue = await ContractList.getNotionalValue(contractId)
        const collateralId = await ContractList.getCollateralId(contractId)
        console.log('about to call getTally in updateContractBalances '+address +' '+collateralId)
        const balances = await TallyMap.getTally(address,collateralId)
        const available = balances.available
        console.log('about to call calc liq price '+available +' '+position.margin+' '+position.contracts+' '+notionalValue+' '+inverse+' '+'avg entry '+position.avgPrice)
        const isLong = position.contracts>0? true: false
        console.log('isLong '+isLong)
        const liquidationInfo = this.calculateLiquidationPrice(available, position.margin, position.contracts, notionalValue, inverse,isLong, position.avgPrice);
        console.log('liquidation info ' +JSON.stringify(liquidationInfo));
        if(liquidationInfo==null){
            position.liqPrice=null
            position.bankruptcyPrice=null
        }else{
            position.liqPrice = liquidationInfo.liquidationPrice
            position.bankruptcyPrice = liquidationInfo.totalLiquidationPrice   
        }
        this.margins.set(address, position);  
        await this.recordMarginMapDelta(address, contractId, newPositionSize, amount,0,0,0,'updateContractBalances')
      
        return position
        //await this.saveMarginMap();
    }

    calculateLiquidationPrice(available, margin, contracts, notionalValue, isInverse, isLong, avgPrice) {
        const balanceBN = new BigNumber(available);
        const marginBN = new BigNumber(margin);
        const contractsBN = new BigNumber(contracts);
        const notionalValueBN = new BigNumber(notionalValue);
        const avgPriceBN = new BigNumber(avgPrice)

        //inverse long    const liquidationPrice = (quantity * (1 / averageEntryPrice - 1 / liquidationPrice)) / -(accountBalance - orderMargin - (quantity / averageEntryPrice) * maintenanceMarginRate - (quantity * fee) / bankruptcyPrice);
        //inverese short  const liquidationPrice = (quantity * (1 / liquidationPrice-1 / averageEntryPrice)) / -(accountBalance - orderMargin - (quantity / averageEntryPrice) * maintenanceMarginRate - (quantity * fee) / bankruptcyPrice);
        const totalCollateralBN = balanceBN.plus(marginBN)
        const positionNotional = notionalValueBN.times(contractsBN)

        let bankruptcyPriceBN = new BigNumber(0)
        let liquidationPriceBN = new BigNumber(0)

        console.log('inside calc liq price '+isInverse, isLong+ 'avail and margin '+available+ ' '+margin)
        if (isInverse==false) {
            // Linear contracts
            // Calculate liquidation price for long position
            if(isLong){
                console.log('inside calc liq isLong linear '+totalCollateralBN.toNumber()+' '+positionNotional.times(avgPriceBN).toNumber()+' avg '+avgPriceBN.toNumber()+' total/notional '+totalCollateralBN.dividedBy(positionNotional).toNumber())
                if (totalCollateralBN.isGreaterThanOrEqualTo(positionNotional.times(avgPriceBN))){
                    return null
                }else{
                   bankruptcyPriceBN = (avgPriceBN.minus(totalCollateralBN.dividedBy(positionNotional))).times(1.005);
                   liquidationPriceBN = bankruptcyPriceBN.plus(avgPriceBN.minus(bankruptcyPriceBN).times(0.5))
                   console.log('calculating linear long '+avgPrice+' total coll.'+(available+margin)+' position notional '+(notionalValue*contracts))
                }
            }else{
                console.log('inside calc liq short linear '+totalCollateralBN.toNumber()+' '+positionNotional.times(avgPriceBN).toNumber()+' avg '+avgPriceBN.toNumber()+' total/notional '+totalCollateralBN.dividedBy(positionNotional).toNumber())
          
                bankruptcyPriceBN = (avgPriceBN.plus(totalCollateralBN.dividedBy(positionNotional))).times(0.995);
                liquidationPriceBN = bankruptcyPriceBN.minus(avgPriceBN.plus(bankruptcyPriceBN).times(0.5))
                console.log('calculating linear short '+avgPrice+' total coll.'+(available+margin)+' position notional '+(notionalValue*contracts))
            }

        } else {
            // Inverse contracts
            // Calculate liquidation price for long inverse position
            if (isLong) {
                bankruptcyPriceBN =  positionNotional.times(1.005).dividedBy(totalCollateralBN);

              liquidationPriceBN = avgPriceBN.minus(
                                    avgPriceBN.times(positionNotional).minus(contractsBN.times(avgPriceBN).times(2))
                                        .minus(bankruptcyPriceBN.times(contractsBN).times(1.000025).times(avgPriceBN))
                                ).dividedBy(contractsBN.plus(positionNotional).minus(contractsBN.times(2))).negated();
          } else {
                // Calculate liquidation price for short inverse position
                if (totalCollateralBN.isGreaterThanOrEqualTo(positionNotional)) {
                   return {bankruptcyPrice: null, liquidationPrice: null}
                } else {
                    bankruptcyPriceBN =  positionNotional.times(0.995).dividedBy(totalCollateralBN);
                    liquidationPriceBN = avgPriceBN.plus(
                                        avgPriceBN.times(positionNotional).minus(contractsBN.times(avgPriceBN).times(2))
                                            .minus(bankruptcyPriceBN.times(contractsBN).times(1.000025).times(avgPriceBN))
                                    ).dividedBy(contractsBN.plus(positionNotional).minus(contractsBN.times(2))).negated();

                                                    }
          }
        }
        let bankruptcyPrice = Math.abs(bankruptcyPriceBN.toNumber())
        let liquidationPrice = Math.abs(liquidationPriceBN.toNumber())
        
        return {
            bankruptcyPrice,
            liquidationPrice
        };
    }

    updateAveragePrice(position, amount, price,contractId) {
        // Convert existing values to BigNumber
        const avgPrice = new BigNumber(position.avgPrice || 0);
        const contracts = new BigNumber(position.contracts || 0);
        const amountBN = new BigNumber(amount);
        const priceBN = new BigNumber(price);

        // Calculate the updated average price
        const updatedAvgPrice = avgPrice
            .times(contracts)
            .plus(amountBN.times(priceBN))
            .dividedBy(contracts.plus(amountBN));

        // Update the position object with the new values
        position.avgPrice = updatedAvgPrice.toNumber(); // Convert back to number if needed
        //position.contracts = contracts.plus(amountBN).toNumber(); // Update the contracts

        this.recordMarginMapDelta(position.address, contractId,0,0,0,0,(avgPrice.toNumber()-updatedAvgPrice.toNumber()),'newAvgPrice')
        // Return the updated position object
        return position.avgPrice;
    }
        
    calculateMarginRequirement(contracts, price, inverse) {
        
        // Ensure that the input values are BigNumber instances
        let bnContracts = new BigNumber(contracts);
        let bnPrice = new BigNumber(price);

        let notional

        // Calculate the notional value
         if (inverse === true) {
            // For inverse contracts, the notional value in denominator collateral is typically the number of contracts divided by the price
            notional = bnContracts.dividedBy(bnPrice);
        } else {
            // For regular contracts, the notional value is the number of contracts multiplied by the price
            notional = bnContracts.multipliedBy(bnPrice);
        }

        // Return 10% of the notional value as the margin requirement
        return notional.multipliedBy(0.1).toNumber();
    }

     /**
     * Checks whether the margin of a given position is below the maintenance margin.
     * If so, it could trigger liquidations or other necessary actions.
     * @param {string} address - The address of the position holder.
     * @param {string} contractId - The ID of the contract.
     */
    async checkMarginMaintainance(address, contractId) {
        let position = this.margins.get(address);

        if (!position) {
            console.error(`No position found for address ${address}`);
            return;
        }

        const ContractRegistry = require('./contractRegistry.js')
        // Calculate the maintenance margin, which is half of the initial margin
        let initialMargin = await ContractRegistry.getInitialMargin(contractId);
        let initialMarginBN = new BigNumber(initialMargin)
        let contractsBN = new BigNumber(position.contracts)
        let maintenanceMarginFactorBN = new BigNumber(0.8)
        let maintenanceMargin = contractsBN.times(initialMarginBN).times(maintenanceMarginFactorBN).toNumber();

        if ((position.margin+position.unrealizedPNL) < maintenanceMargin) {
            console.log(`Margin below maintenance level for address ${address}. Initiating liquidation process.`);
            // Trigger liquidation or other necessary actions here
            // Example: this.triggerLiquidation(address, contractId);
            return true
        } else {
            console.log(`Margin level is adequate for address ${address}.`);
            return false
        }
    }
   
    async reduceMargin(pos, contracts, pnl, isInverse, contractId, address,side, feeDebit,fee) {
        //console.log('checking position inside reduceMargin ' + JSON.stringify(pos));
        //console.log('checking PNL math in reduceMargin '+pnl+' '+address)
        if (!pos) return { netMargin: new BigNumber(0), mode: 'none' };
        // Calculate the remaining margin after considering pnl
        //let remainingMargin = new BigNumber(pos.margin).plus(pnl);
        //if(pnl>0){
            let remainingMargin = new BigNumber(pos.margin)
        //}
        //console.log('inside reduce margin ' + JSON.stringify(remainingMargin.toNumber()));

        // Check if maintenance margin is hit, and if yes, pro-rate reduction
            let contractAmount = new BigNumber(contracts);
            let existingPosition = 0
            if(side==false){
                existingPosition = new BigNumber(pos.contracts).plus(contractAmount)
            }else if(side ==true){
                existingPosition = new BigNumber(pos.contracts).minus(contractAmount)
            }

            if(existingPosition==0){
                //for some reason the math is off and this is going to create Infinity as a result so to avoid a throw
                console.log('issue with calculating existing position '+existingPosition+' '+side+' pos '+pos.contracts +' '+contractAmount)
                return existingPosition 
            }
            existingPosition = Math.abs(existingPosition)
            // Now you can use the dividedBy method
            let reduction = remainingMargin.times(contractAmount.dividedBy(existingPosition));
            // Update the margin and contracts based on the reduction ratio
           let posMargin = new BigNumber(pos.margin);

            // Now you can use the minus method
            posMargin = posMargin.minus(reduction);

            // Assign the updated pos.margin
            pos.margin = posMargin.toNumber();    
            if(feeDebit){
                console.log('debiting fee in reduce margin '+fee)
                pos.margin-=fee
                reduction = reduction.toNumber()
                reduction -=fee
            }else{
                reduction.toNumber()
            }
            //console.log('margin map cannot have negative margin '+pos.margin+' '+reduction)
             
        this.margins.set(address, pos);
        await this.recordMarginMapDelta(address, contractId, 0, 0, -reduction,0,0,'marginReduction')
        //console.log('returning from reduceMargin '+reduction + ' '+JSON.stringify(pos)+ 'contractAmount '+contractAmount)
        await this.saveMarginMap(true);
        return reduction;
    }

    async feeMarginReduce(address,pos, reduction,contractId){
             // Now you can use the minus method
        pos.margin -= reduction
                   
        this.margins.set(address, pos);
        await this.recordMarginMapDelta(address, contractId, 0, 0, -reduction,0,0,'marginFeeReduction')
        //console.log('returning from reduceMargin '+reduction + ' '+JSON.stringify(pos)+ 'contractAmount '+contractAmount)
        await this.saveMarginMap(true);
        return pos;
    }

    realizePnl(address, contracts, price, avgPrice, isInverse, notionalValue, pos, isBuy,contractId) {
        if (!pos) return new BigNumber(0);

        let pnl;
        //console.log('inside realizedPNL ' + address + ' ' + contracts + ' trade price ' + price + ' avg. entry ' + avgPrice + ' is inverse ' + isInverse + ' notional ' + notionalValue + ' position' + JSON.stringify(pos));
        if(avgPrice==0||avgPrice==null||avgPrice==undefined||isNaN(avgPrice)){
            console.log('weird avg. price input for realizedPNL ' +avgPrice+' '+address+ ' '+price+' '+JSON.stringify(pos))
        }
        const priceBN = new BigNumber(price);
        const avgPriceBN = new BigNumber(avgPrice);
        const contractsBN = new BigNumber(contracts);
        const notionalValueBN = new BigNumber(notionalValue);

        if (isInverse) {
            // For inverse contracts: PnL = (1/entryPrice - 1/exitPrice) * contracts * notional
            pnl = priceBN
                .minus(1)
                .dividedBy(avgPriceBN.minus(1))
                .times(contractsBN)
                .times(notionalValueBN);

            //console.log('pnl ' + pnl.toNumber());
        } else {
            // For linear contracts: PnL = (exitPrice - entryPrice) * contracts * notional
            pnl = priceBN
                .minus(avgPriceBN)
                .times(contractsBN)
                .times(notionalValueBN);

            //console.log('pnl ' + pnl.toNumber());
        }

        // Adjust the sign based on the isBuy flag
        pnl = isBuy ? pnl.negated() : pnl;

        // Modify the position object
        // pos.margin = pos.margin.minus(Math.abs(pnl)); // adjust as needed
        // pos.unrealizedPl = pos.unrealizedPl.plus(pnl);

        //console.log('inside realizePnl ' + pnl + ' price then avgPrice ' + avgPrice + ' contracts ' + contracts + ' notionalValue ' + notionalValue);
        this.recordMarginMapDelta(address, contractId,0,0,0,pnl,0,'rPNL')
      
        return pnl;
    }

    async recordMarginMapDelta(address, contractId, total, contracts, margin, uPNL, avgEntry, mode) {
            const newUuid = uuid.v4();
            const dbInstance = db.getDatabase('marginMapDelta');
            const deltaKey = `${address}-${contractId}-${newUuid}`;
            const delta = { address, contract: contractId, totalPosition: total, position: contracts, margin: margin, uPNL: uPNL, avgEntry, mode };

            console.log('saving marginMap delta ' + JSON.stringify(delta));

            try {
                // Try to find an existing document based on the key
                const existingDocument = await dbInstance.findOneAsync({ _id: deltaKey });

                if (existingDocument) {
                    // If the document exists, update it
                    await dbInstance.updateAsync({ _id: deltaKey }, { $set: { data: delta } });
                } else {
                    // If the document doesn't exist, insert a new one
                    await dbInstance.insertAsync({ _id: deltaKey, data: delta });
                }

                return; // Return success or handle as needed
            } catch (error) {
                console.error('Error saving marginMap delta:', error);
                throw error; // Rethrow the error or handle as needed
            }
    }



    /*realizePnl(address, contracts, price, avgPrice, isInverse, notionalValue, pos) {
        //const pos = this.margins.get(address);

        if (!pos) return 0;

        let pnl;
        console.log('inside realizedPNL '+address + ' '+contracts + ' trade price ' +price + ' avg. entry '+avgPrice + ' is inverse '+ isInverse + ' notional '+notionalValue + ' position' +JSON.stringify(pos))
        if (isInverse) {
            // For inverse contracts: PnL = (1/entryPrice - 1/exitPrice) * contracts * notional
            pnl = (1 / avgPrice - 1 / price) * contracts * notionalValue;
            console.log('pnl '+pnl)
        } else {
            // For linear contracts: PnL = (exitPrice - entryPrice) * contracts * notional
            pnl = (price - avgPrice) * contracts * notionalValue;
            console.log('pnl '+(price - avgPrice), contracts, notionalValue, pnl)
        }

        //pos.margin -= Math.abs(pnl);
        //pos.unrealizedPl += pnl; //be sure to modify uPNL and scoop it out for this value...
        console.log('inside realizePnl '+price + ' price then avgPrice '+avgPrice +' contracts '+contracts + ' notionalValue '+notionalValue)
        return pnl;
    }*/

    async settlePNL(address, contracts, price, avgEntry, contractId, currentBlockHeight) {
            const pos = this.margins.get(address);

            if (!pos) return 0;
            const ContractRegistry = require('./contractRegistry.js')
            // Check if the contract is associated with an oracle
            const isOracleContract = await ContractRegistry.isOracleContract(contractId);

            let oraclePrice;
            if (isOracleContract) {
                // Retrieve the oracle ID associated with the contract
                const oracleId = await ContractRegistry.getOracleId(contractId);

                // Retrieve the latest oracle data for the previous block
                const oracleData = await ContractRegistry.getLatestOracleData(oracleId, currentBlockHeight - 1);
                //console.log('inside settlePNL oracle retrieval '+JSON.stringify(oracleData)+' '+JSON.stringify(oracleData.data)+' '+JSON.stringify(oracleData.data.price))
                oraclePrice = oracleData.data.price
            }

            // Use settlement price based on the oracle data or LIFO Avg. Entry
            const settlementPrice = isOracleContract ? oraclePrice : avgEntry;

            // Calculate PnL based on settlement price
            console.log('inside settlePNL ' +settlementPrice+' '+price+' is oracle '+isOracleContract+'oracle price '+oraclePrice+' '+avgEntry)
            const pnl = new BigNumber((price - settlementPrice) * Math.abs(contracts));
            console.log('calculated settle PNL '+pnl.toNumber()+' '+JSON.stringify(pnl))
            if (contracts < 0) {
                pnl.negated(); // Invert the value if contracts is negative
            }
            // Update margin and unrealized PnL
            //pos.margin -= Math.abs(pnl);
            pos.unrealizedPNL -= pnl;
            this.margins.set(address, pos)
            await this.recordMarginMapDelta(address, contractId, pos.contracts-contracts, contracts, 0, -pnl, 0, 'settlementPNL')
  
            return pnl.toNumber();
    }

    async clear(position, address, pnlChange, avgPrice,contractId) {
            if(position.unrealizedPNL==null||position.unrealizedPNL==undefined){
                position.unrealizedPNL=0
            }
            position.unrealizedPNL+=pnlChange
            this.margins.set(address, position)
            await this.recordMarginMapDelta(address, contractId, position.contracts, 0, 0, pnlChange, avgPrice, 'markPrice')
            return position
    }

    async triggerLiquidations(position, blockHeight, contractId) {
        // Logic to handle the liquidation process
        // This could involve creating liquidation orders and updating the contract's state

        // Example:
        const liquidationOrder = this.generateLiquidationOrder(position, contractId);
        await this.saveLiquidationOrders(contractId, position, liquidationOrder, blockHeight);

        return liquidationOrder;
    }

    generateLiquidationOrder(position, contractId) {
                // Liquidate 50% of the position if below maintenance margin
                let side 
                if(position.contracts>0){
                    side = false
                }else if(position.contracts<0){
                    side = true
                }else if(position.contracts==0){
                    return "err:0 contracts"
                }
                const liquidationSize = position.contracts * 0.5;
                const liquidationOrder={
                    address: position.address,
                    contractId: contractId,
                    size: liquidationSize,
                    price: position.liqPrice,
                    side: side,
                    bankruptcyPrice: position.bankruptcyPrice

                }
        return liquidationOrder;
    }

    async saveLiquidationOrders(contractId, position, order, blockHeight) {
        try {
            // Access the marginMaps database
            const liquidationsDB = db.getDatabase('liquidations');

            // Construct the key and value for storing the liquidation orders
            const key = `liquidationOrders-${contractId}-${blockHeight}`;
            const value = { _id: key, order: order, position: position, blockHeight: blockHeight };

            // Save the liquidation orders in the marginMaps database
            await liquidationsDB.insertAsync(value);
        } catch (error) {
            console.error(`Error saving liquidation orders for contract ${contractId} at block height ${blockHeight}:`, error);
            throw error;
        }
    }

    async fetchLiquidationVolume(blockHeight, contractId, mark) {
        const liquidationsDB = db.getDatabase('liquidations');
        // Fetch liquidations from the database for the given contract and blockHeight
        let liquidations = []

        try {
                // Construct the key based on the provided structure
                const key = `liquidationOrders-${contractId}-${blockHeight}`;
                
                // Find the document with the constructed key
                liquidations = await liquidationsDB.findOneAsync({ _id: key });
            } catch (error) {
                console.error('Error fetching liquidations:', error);
            }
        // Initialize BigNumber instances
        let liquidatedContracts = new BigNumber(0);
        let filledLiqContracts = new BigNumber(0);
        let bankruptcyVWAPPreFill = new BigNumber(0);
        let filledVWAP = new BigNumber(0);
        let avgBankrupcyPrice = new BigNumber(0);
        let liquidationOrders = new BigNumber(0);
        let sells = new BigNumber(0);
        let buys = new BigNumber(0);

        // Calculate values using BigNumber
        if (liquidations && liquidations.length > 0) {
            liquidations.forEach(liquidation => {
                liquidationOrders = liquidationOrders.plus(1);
                liquidatedContracts = liquidatedContracts.plus(liquidation.contractCount);
                bankruptcyVWAPPreFill = bankruptcyVWAPPreFill.plus(new BigNumber(liquidation.size).times(new BigNumber(liquidation.bankruptcyPrice)));
                avgBankrupcyPrice = avgBankrupcyPrice.plus(new BigNumber(liquidation.bankruptcyPrice));
                if (liquidation.side == false) {
                    sells = sells.plus(0);
                } else if (liquidation.side == true) {
                    buys = buys.plus(0);
                }
            });
        }else{
            console.log("No liquidations found for the given criteria.");
        }

        bankruptcyVWAPPreFill = bankruptcyVWAPPreFill.dividedBy(liquidatedContracts);
        avgBankrupcyPrice = avgBankrupcyPrice.dividedBy(liquidationOrders);

        const tradeHistoryDB = db.getDatabase('tradeHistory');
        const tradeKey = `liquidationOrders-${contractId}-${blockHeight}`;
        // Fetch trade history for the given blockHeight and contractId
        const trades = await tradeHistoryDB.findAsync();

        // Count the number of liquidation orders in the trade history
        let liquidationTradeMatches = new BigNumber(0);
        trades.forEach(trade => {
            if (trade.trade.isLiq === true&&trade.blockHeight==blockHeight) {
                liquidationTradeMatches = liquidationTradeMatches.plus(1);
                filledLiqContracts = filledLiqContracts.plus(trade.trade.amount);
                filledVWAP = filledVWAP.plus(trade.trade.tradePrice);
            }
        });
        filledVWAP = filledVWAP.dividedBy(filledLiqContracts);

        // Calculate the unfilled liquidation order contract count
        const unfilledLiquidationContracts = liquidatedContracts.minus(filledLiqContracts);
        const lossDelta = bankruptcyVWAPPreFill.minus(filledVWAP);

        return {
            liqTotal: liquidatedContracts.toNumber(),
            liqOrders: liquidationOrders.toNumber(),
            unfilled: unfilledLiquidationContracts.toNumber(),
            bankruptcyVWAPPreFill: bankruptcyVWAPPreFill.toNumber(),
            filledVWAP: filledVWAP.toNumber(),
            lossDelta: lossDelta.toNumber()
        };
    }


    needsLiquidation(contract) {
        const maintenanceMarginFactor = 0.05; // Maintenance margin is 5% of the notional value

        for (const [address, position] of Object.entries(this.margins[contract.id])) {
            const notionalValue = position.contracts * contract.marketPrice;
            const maintenanceMargin = notionalValue * maintenanceMarginFactor;

            if (position.margin < maintenanceMargin) {
                return true; // Needs liquidation
            }
        }
        return false; // No positions require liquidation
    }


     // Get the position for a specific address
      async getPositionForAddress(address, contractId) {
        let position = this.margins.get(address);
        //console.log('loading position for address '+address +' contract '+contractId + ' ' +JSON.stringify(position) )
        // If the position is not found or margins map is empty, try loading from the database
        if (!position || this.margins.length === 0) {
            //console.log('going into exception for getting Position ')
            await MarginMap.loadMarginMap(contractId);
            position = this.margins.get(address);
        }

        // If still not found, return a default position
        if (!position) {
            return {
                contracts: 0,
                margin: 0,
                unrealizedPl: 0,
                // Add other relevant fields if necessary
            };
        }

        return position;
    }

    async getMarketPrice(contract) {
        let marketPrice;

        if (ContractsRegistry.isOracleContract(contract.id)) {
            // Fetch the 3-block TWAP for oracle-based contracts
            marketPrice = await Oracles.getTwap(contract.id, 3); // Assuming the getTwap method accepts block count as an argument
        } else if (ContractsRegistry.isNativeContract(contract.id)) {
            // Fetch VWAP data for native contracts
            const contractInfo = ContractsRegistry.getContractInfo(contract.id);
            if (contractInfo && contractInfo.indexPair) {
                const [propertyId1, propertyId2] = contractInfo.indexPair;
                marketPrice = await VolumeIndex.getVwapData(propertyId1, propertyId2);
            }
        } else {
            throw new Error(`Unknown contract type for contract ID: ${contract.id}`);
        }

        return marketPrice;
    }

}

module.exports = MarginMap