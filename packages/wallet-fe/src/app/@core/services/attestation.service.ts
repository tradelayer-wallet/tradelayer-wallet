import { Injectable } from "@angular/core";
import { ToastrService } from "ngx-toastr";
import { AuthService } from "./auth.service";
import { RpcService } from "./rpc.service";
import { ApiService } from "./api.service";
import { environment } from "src/environments/environment";

@Injectable({
    providedIn: 'root',
})

export class AttestationService {
    private attestations: { 
      address: string; 
      isAttested: boolean | 'PENDING'; 
      data?: { status: string; [key: string]: any }; // Optional data field
    }[] = [];
    private attestationRefreshId: ReturnType<typeof setInterval> | null = null;
    private pendingPendingCheckId: ReturnType<typeof setTimeout> | null = null;
    private checkAllInProgress = false;

    constructor(
        private authService: AuthService,
        private rpcService: RpcService,
        private apiService: ApiService,
        private toastrService: ToastrService,
    ) { }

    get tlApi() {
        return this.apiService.newTlApi;
    }

    onInit() {
        this.authService.updateAddressesSubs$
            .subscribe(kp => {
                if (!kp.length) this.removeAll();
                this.queueCheckAllAtt(0);
            });

        this.rpcService.blockSubs$
            .subscribe(() => this.queueCheckPending(60000));
        console.log('initializing attestation loop')    
        this.startAttestationUpdateInterval();
    }

    startAttestationUpdateInterval() {
        if (this.attestationRefreshId) {
            clearInterval(this.attestationRefreshId);
        }
        this.queueCheckAllAtt(0); // Call immediately to fetch fresh data
        this.attestationRefreshId = setInterval(() => this.queueCheckAllAtt(0), 120000); // Update every 2 minutes
    }

    private queueCheckAllAtt(delayMs: number) {
        if (this.attestationRefreshId == null && delayMs <= 0) {
            void this.checkAllAtt();
            return;
        }
        setTimeout(() => void this.checkAllAtt(), Math.max(0, Number(delayMs || 0)));
    }

    async refreshAttestations(addresses: string[] = this.authService.listOfallAddresses) {
        return this.checkAllAtt(addresses);
    }

    private async checkAllAtt(addresses?: string[]) {
        if (this.checkAllInProgress) return;
        this.checkAllInProgress = true;
        const addressesList = addresses || this.authService.listOfallAddresses
            
        try {
            for (let i = 0; i < addressesList.length; i++) {
                const address = addressesList[i];
                await this.checkAttAddress(address);
            }
        } finally {
            this.checkAllInProgress = false;
        }
    }

      async checkAttAddress(address: string): Promise<boolean> {
        try {
            const aRes = await this.tlApi.rpc('getAttestations', [address, 0]).toPromise();

            // Extract and flatten the 'data' array
            const attestationArray = aRes?.data || [];
            
            // Find the most recent 'active' attestation
            const attestationData = attestationArray.find(
                (entry: any) => entry?.data?.status === 'active'
            );

            const isAttested = !!attestationData;

            // Update attestation cache
            const existing = this.attestations.find(a => a.address === address);

            if (existing) {
                existing.isAttested = isAttested;
                existing.data = attestationData?.data || null; // Store the full attestation data
            } else {
                this.attestations.push({ 
                    address, 
                    isAttested, 
                    data: attestationData?.data || null 
                });
            }

            return isAttested;

        } catch (error: any) {
            console.error('Error fetching attestations:', error.message);
            return false;
        }
    }





    private removeAll() {
        this.attestations = [];
    }
    
    private async checkPending() {
        for (const attestation of this.attestations.filter(a => a.isAttested === 'PENDING')) {
            const isAttested = await this.checkAttAddress(attestation.address);
            attestation.isAttested = isAttested || 'PENDING'; // Update to 'true' if attested, else remain 'PENDING'
        }
    }

    private queueCheckPending(delayMs: number) {
        if (this.pendingPendingCheckId) {
            clearTimeout(this.pendingPendingCheckId);
            this.pendingPendingCheckId = null;
        }
        this.pendingPendingCheckId = setTimeout(() => {
            this.pendingPendingCheckId = null;
            void this.checkPending();
        }, Math.max(0, Number(delayMs || 0)));
    }

    
    getAttByAddress(address: string): string | 'PENDING' | false {
        const attestation = this.attestations.find(e => e.address === address);

        // If attestation is undefined, return false
        if (!attestation) {
            return false;
        }

        // Explicitly check if the attestation is marked as 'PENDING'
        if (attestation.isAttested === 'PENDING') {
            return 'PENDING';
        }

        // Return the status if attestation data exists
        return attestation.data?.status || false;
    }


    setPendingAtt(address: string) {
        const existing = this.attestations.find(a => a.address === address);
        if (existing) {
            existing.isAttested = 'PENDING';
        } else {
            this.attestations.push({ address, isAttested: 'PENDING' });
        }
    }

    async checkIP(): Promise<any> {
        const baseUrl = this.getRelayerBaseUrl();
        const response = await fetch(`${baseUrl}/attestation/ip`, {
            method: "GET",
            headers: { "content-type": "application/json" },
        });
        const text = await response.text();
        let data: any = text;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {}

        if (!response.ok) {
            throw new Error(data?.error || data?.message || text || `IP attestation failed (${response.status})`);
        }

        const attestation = data?.attestation || {
            ip: data?.ip,
            country: data?.countryCode,
            countryCode: data?.countryCode,
            isVpn: data?.isVpn,
            isProxy: data?.isProxy,
            isDarkweb: data?.isDarkweb,
            isAnonymousVpn: data?.isAnonymousVpn,
            isBlocked: data?.isBlocked,
            message: data?.message,
            source: data?.source,
        };

        return {
            ...data,
            attestation,
            success: data?.success !== false,
        };
    }

    private getRelayerBaseUrl(): string {
        const network = this.rpcService.NETWORK || "LTC";
        const configured = this.apiService.apiUrl || environment.ENDPOINTS?.[network]?.relayerUrl || environment.ENDPOINTS?.LTC?.relayerUrl;
        const fallback = String(network).toUpperCase().includes("TEST")
            ? "https://testnet-api.layerwallet.com/relayer"
            : "https://api.layerwallet.com/relayer";
        const url = String(configured || fallback).replace(/\/+$/, "");

        if (/^http:\/\/172\.81\.181\.19:8191\/?$/.test(url)) {
            return "https://testnet-api.layerwallet.com/relayer";
        }
        if (/^http:\/\/172\.81\.181\.19:9191\/?$/.test(url)) {
            return "https://api.layerwallet.com/relayer";
        }
        return url;
    }

}
