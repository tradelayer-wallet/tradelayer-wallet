export const getDataDefaultStrategy = (options: any, balanceLTC: number, balanceTokens: number) => {
    const { marketName, first_token, second_token, price, address, pubKey } = options;
    const orders = [];
    const forEachPercent = 0.1;
    const percentage = [0.5, 1.5, 3, 6, 20, 50, 65, 80, 95];
    const amountAll = parseFloat((forEachPercent * balanceTokens).toFixed(6))

    percentage.forEach(percent => {
        const abovePrice = parseFloat((price + (percent / 100) * price).toFixed(6));
        const belowPrice = parseFloat((price - (percent / 100) * price).toFixed(6));
        const amountLTCTotal = parseFloat((balanceLTC / percentage.length).toFixed(6));
        const amountLTC = parseFloat((amountLTCTotal / belowPrice).toFixed(6));

        const optLtc = { marketName, first_token, second_token, tokens: amountLTC, address, pubKey };
        const optAll = { marketName, first_token, second_token, tokens: amountAll, address, pubKey };
        const order1 = newOrder(optLtc, belowPrice, true);
        const order2 = newOrder(optAll, abovePrice, false);
        orders.push(order1, order2)
    });
    return orders;
}

const newOrder = (options: any, price: number, isBuy: boolean) => {
    const { marketName, first_token, second_token, tokens, address, pubKey } = options;
    return {
        address, pubKey, marketName, isBuy, price,
        amount: tokens,
        propIdDesired: isBuy ? first_token : second_token,
        propIdForSale: isBuy ? second_token : first_token,
    }
};
