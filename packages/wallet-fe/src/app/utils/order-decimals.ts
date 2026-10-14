// The orderbook server accepts an order amount or price only when it is a whole number of 1e-8
// units (at most 8 decimal places). Float arithmetic can add digits (0.1 + 0.2 is
// 0.30000000000000004), and the amount field takes whatever the user typed, so every outbound
// order is rounded to 8 decimals here, at the one place the order is emitted.
export const toOrderDecimal = (value: number | string): number => parseFloat(Number(value).toFixed(8));

export const withOrderDecimals = <T extends { props: { amount: any; price: any } }>(conf: T): T => ({
    ...conf,
    props: {
        ...conf.props,
        amount: toOrderDecimal(conf.props.amount),
        price: toOrderDecimal(conf.props.price),
    },
});
