import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { AuthService } from "./auth.service";
import { RpcService } from "./rpc.service";

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

    
    async function checkIP(ipAddress) {
          const primaryUrl = `https://api.criminalip.io/v1/asset/ip/report?ip=${ipAddress}`;
          const fallbackUrl = `https://ipinfo.io/json?token=${IPINFO_TOKEN}`;

          try {
            // Call primary API
            const response = await axios.get(primaryUrl, {
              headers: {
                "x-api-key": CRIMINAL_IP_API_KEY,
              },
            });

            if (response.status === 200 && response.data) {
              const data = response.data;

              // Check suspicious parameters
              const { issues, whois } = data;
              if (
                issues.is_vpn ||
                issues.is_darkweb ||
                issues.is_proxy ||
                issues.is_anonymous_vpn ||
                whois.data.some((entry) => entry.org_country_code === "us")
              ) {
                throw new Error("Suspicious IP detected or IP is in the US.");
              }

              // Create attestation
              const countryCode = whois.data[0]?.org_country_code || "Unknown";
              return {
                success: true,
                attestation: {
                  ip: ipAddress,
                  countryCode,
                  message: "IP is clean and trusted.",
                },
              };
            } else {
              throw new Error("No response or invalid response from Criminal IP API.");
            }
          } catch (error) {
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
            } catch (fallbackError) {
              console.error("Fallback API failed:", fallbackError.message);
              return {
                success: false,
                error: "Both primary and fallback APIs failed.",
              };
            }
          }
        }
}