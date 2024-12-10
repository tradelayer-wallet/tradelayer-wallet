import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { AuthService } from "./auth.service";
import { RpcService } from "./rpc.service";
import axios from 'axios'

@Injectable({
    providedIn: 'root',
})

export class AttestationService {
    private attestations: {address: string, isAttested: boolean | 'PENDING' }[] = [];
    constructor(
        private authService: AuthService,
        private rpcService: RpcService,
        private toastrService: ToastrService,
    ) { }

    private readonly CRIMINAL_IP_API_KEY = "RKohp7pZw3LsXBtbmU3vcaBByraHPzDGrDnE0w1vI0qTEredJnMPfXMRS7Rk";
    private readonly IPINFO_TOKEN = "5992daa04f9275";


    onInit() {
        this.authService.updateAddressesSubs$
            .subscribe(kp => {
                if (!kp.length) this.removeAll();
                this.checkAllAtt();
            });

        this.rpcService.blockSubs$
            .subscribe(() => this.checkPending());
    }

    private async checkAllAtt() {
        const addressesList = this.authService.listOfallAddresses
            .map(({ address }) => address)
            .filter(a => !this.attestations.map(e => e.address).includes(a));
        for (let i = 0; i < addressesList.length; i++) {
            const address = addressesList[i];
            await this.checkAttAddress(address);
        }
    }

    async checkAttAddress(address: string): Promise<boolean> {
        try {
            const aRes = await this.rpcService.rpc('tl_check_kyc', [address]);
            if (aRes.error || !aRes.data) throw new Error(aRes.error);
            const isAttested = aRes.data['result: '] === 'enabled(kyc_0)';
            const existing = this.attestations.find(a => a.address === address);
            existing
                ? existing.isAttested = isAttested
                : this.attestations.push({ address, isAttested });
            return isAttested;
        } catch (error: any) {
            this.toastrService.error(error.messagokee, `Checking Attestations Error, Adress: ${address}`);
            return false;
        }
    }

    private removeAll() {
        this.attestations = [];
    }
    
    private async checkPending() {
        const pendingList = this.attestations.filter(a => a.isAttested === 'PENDING');
        for (let i = 0; i < pendingList.length; i++) {
            const address = pendingList[i].address;
            const isAttested = await this.checkAttAddress(address);
            const existing = this.attestations.find(a => a.address === address);
            existing
                ? existing.isAttested = isAttested
                : this.attestations.push({ address, isAttested });
        }
    }
    
    getAttByAddress(address: string) {
        return this.attestations
            .find(e => e.address === address)?.isAttested || false;
    }

    setPendingAtt(address: string) {
        const existing = this.attestations.find(a => a.address === address);
        if (existing) existing.isAttested = 'PENDING';
    }

   async checkIP(): Promise<any> {
        let ipAddress = ''
        const ipFetchUrls = [
          "http://ip-api.com/json",
          "https://api.ipify.org?format=json"
        ];

        for (const url of ipFetchUrls) {
          try {
            const response = await fetch(url);
            const data = await response.json();
            if (data?.ip) {
              ipAddress = data.ip; // For ipify.org
              console.log(`IP fetched from ${url}: ${ipAddress}`);
              break;
            } else if (data?.query) { // For ip-api.com
              ipAddress = data.query;
              console.log(`IP fetched from ${url}: ${ipAddress}`);
              break;
            }
          } catch (error) {
            console.error(`Failed to fetch IP from ${url}:`, error.message);
          }
        }

        if (!ipAddress) {
          throw new Error("Unable to determine client IP address from available sources.");
        }

    const primaryUrl = `https://api.criminalip.io/v1/asset/ip/report?ip=${ipAddress}`;
    const fallbackUrl = `https://ipinfo.io/json?token=${this.IPINFO_TOKEN}`;

    try {
      // Call primary API
      const response = await axios.get(primaryUrl, {
        headers: {
          "x-api-key": this.CRIMINAL_IP_API_KEY,
        },
      });

      if (response.status === 200 && response.data) {
        const data = response.data;

        // Check suspicious parameters
        const { issues, whois } = data;
       const bannedCountries = ["US", "KP", "SY", "SD", "RU", "IR"]; // Add sanctioned country codes

        if (
          issues.is_vpn ||
          issues.is_darkweb ||
          issues.is_proxy ||
          issues.is_anonymous_vpn ||
          whois.data.some((entry: { org_country_code: string }) => bannedCountries.includes(entry.org_country_code))
        ) {
          throw new Error("Suspicious IP detected or originating from a sanctioned country.");
        }


        // Create attestation
        const countryCode = whois.data[0]?.org_country_code || "Unknown";
        return {
          success: true,
          attestation: {
            ip: ipAddress,
            country: countryCode,
            message: "IP is clean and trusted.",
          },
        };
      } else {
        throw new Error("No response or invalid response from Criminal IP API.");
      }
    } catch (error: any) {
      console.error("Primary API failed:", error.message);

      // Fallback logic
      try {
        const fallbackResponse = await fetch(fallbackUrl);
        const fallbackData = await fallbackResponse.json();

        if (fallbackData) {
          const { ip, country, privacy } = fallbackData;

          // Check for VPN or US
          if (privacy.vpn || country === "US") {
            throw new Error("Fallback: Suspicious IP or IP is in the US.");
          }

          // Create fallback attestation
          return {
            success: true,
            attestation: {
              ip,
              countryCode: country,
              message: "Fallback API: IP is clean and trusted.",
            },
          };
        } else {
          throw new Error("No response from fallback API.");
        }
      } catch (fallbackError: any) {
        console.error("Fallback API failed:", fallbackError.message);
        return {
          success: false,
          error: "Both primary and fallback APIs failed.",
        };
      }
    }
  }

}