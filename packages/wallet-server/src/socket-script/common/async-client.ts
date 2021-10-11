import { customLogger } from './logger';
import { ApiRes } from './types';

export const asyncClient = (ltcClient: any) => async (...args: any[]): Promise<ApiRes> =>
(await new Promise((resolve) => {
    try {
        ltcClient.cmd(...args, (error: any, data: any) => {
            const result: ApiRes = { error: null, data: null };
            if (error) customLogger(`rpc_${JSON.stringify(args)}:${JSON.stringify(error)}`);
            if (error) result.error = error.message;
            if (data) result.data = data;
            resolve(result);
        })
    } catch (error) {
        resolve(error.message)
    }
}));