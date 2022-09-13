<<<<<<< HEAD
import { ENDPOINTS } from "./endpoints.conf";
export const environment = { 
    production: true , 
    homeApiUrl: "http://localhost:1986",
    ENDPOINTS,
};
=======
export const environment = {
  production: true,
  homeApiUrl: 'http://localhost:1986',
  orderbook_service_url: 'http://170.75.174.87:9190',
  orderbook_service_url_testnet: 'http://ec2-13-40-194-140.eu-west-2.compute.amazonaws.com:3002',
  relayerUrl: 'http://170.75.174.87:9191',
  relayerUrlTestnet: 'http://ec2-13-40-194-140.eu-west-2.compute.amazonaws.com:9191',
};
>>>>>>> master
