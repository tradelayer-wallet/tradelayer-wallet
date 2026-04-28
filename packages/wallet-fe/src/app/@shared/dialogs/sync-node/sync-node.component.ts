import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { ToastrService } from 'ngx-toastr';
import { ApiService } from 'src/app/@core/services/api.service';
import { AuthService } from 'src/app/@core/services/auth.service';
import { DialogService, DialogTypes } from 'src/app/@core/services/dialogs.service';
import { ElectronService } from 'src/app/@core/services/electron.service';
import { LoadingService } from 'src/app/@core/services/loading.service';
import { ENetwork, RpcService } from 'src/app/@core/services/rpc.service';

@Component({
  selector: 'sync-node-dialog',
  templateUrl: './sync-node.component.html',
  styleUrls: ['./sync-node.component.scss']
})
export class SyncNodeDialog implements OnInit, OnDestroy {
    readyPercent: number = 0;
    message: string = '';
    eta: string = 'Calculating Remaining Time ...';
    tlReadyPercent: number = 0;
    tlEta: string = 'Waiting for TradeLayer parser status ...';
    tlMessage: string = '';
    tlSyncStatus: any = null;

    prevEtaData: {
        stamp: number;
        blocks: number;
    } = {
        stamp: 0,
        blocks: 0,
    };
    prevTlEtaData: {
        stamp: number;
        blocks: number;
    } = {
        stamp: 0,
        blocks: 0,
    };

    private checkIntervalFunc: any;

    // Add this variable to prevent multiple sync processes from running simultaneously
    private isCheckingSync: boolean = false;


    constructor(
        private rpcService: RpcService,
        private apiService: ApiService,
        private loadingService: LoadingService,
        private electronService: ElectronService,
        private zone: NgZone,
        private dialogService: DialogService,
        private router: Router,
        private toastrService: ToastrService,
        private authService: AuthService,
    ) {}

    get coreStarted() {
        return this.rpcService.isCoreStarted;
    }

    get isSynced() {
        return this.rpcService.isSynced;
    }

    get nodeBlock() {
        return this.rpcService.lastBlock;
    }

    get networkBlocks() {
        return this.rpcService.networkBlocks;
    }

    get isAbleToRpc() {
        return this.rpcService.isAbleToRpc;
    }

    get headerBlock() {
        return this.rpcService.headerBlock;
    }

    get tlCurrentBlock() {
        return Number(
            this.tlSyncStatus?.currentHeight
            || this.tlSyncStatus?.processedHeight
            || this.tlSyncStatus?.trackHeight
            || 0
        );
    }

    get tlTargetBlock() {
        return Number(
            this.tlSyncStatus?.targetHeight
            || this.tlSyncStatus?.chainTip
            || this.tlSyncStatus?.headerBlock
            || this.tlSyncStatus?.nodeBlock
            || 0
        );
    }

    get tlIsSynced() {
        return this.tlTargetBlock > 0 && this.tlCurrentBlock + 1 >= this.tlTargetBlock;
    }

    get tlPhaseLabel() {
        const phase = String(this.tlSyncStatus?.phase || '').trim().toLowerCase();
        if (phase === 'indexing') return 'Indexing TradeLayer transactions';
        if (phase === 'reconstructing-consensus') return 'Reconstructing TradeLayer consensus';
        if (phase === 'realtime') return this.tlIsSynced ? 'TradeLayer synchronized' : 'Processing live TradeLayer blocks';
        if (phase === 'starting') return 'Starting TradeLayer parser';
        if (phase === 'paused') return 'TradeLayer parsing paused';
        if (phase === 'error') return 'TradeLayer parser error';
        if (phase === 'unavailable') return 'TradeLayer listener unavailable';
        return 'TradeLayer parser status';
    }

    get tlStatusText() {
        const eta = this.tlEta && this.tlEta !== 'Waiting for TradeLayer parser status ...'
            ? this.tlEta
            : '';
        const message = this.formatDialogError(this.tlSyncStatus?.message || this.tlMessage || '', '');
        if (eta && message) return `${this.tlPhaseLabel} | ${eta}`;
        if (eta) return `${this.tlPhaseLabel} | ${eta}`;
        if (message) return message;
        return this.tlPhaseLabel;
    }

    private formatDialogError(error: any, fallback = 'Undefined Error') {
        let raw = String(error?.error?.error || error?.error?.message || error?.message || error || fallback);
        if (raw === '[object Object]') {
            try {
                raw = JSON.stringify(error);
            } catch {
                raw = fallback;
            }
        }
        const normalized = raw.replace(/\s+/g, ' ').trim();
        const lower = normalized.toLowerCase();
        if (!normalized) return '';
        if (lower.includes('eaddrinuse') || lower.includes('address already in use') || lower.includes(':3000')) {
            return 'TradeLayer listener is already running; attaching to it.';
        }
        if (lower.includes('status code 500')) {
            return 'Local wallet service returned an error while starting TradeLayer.';
        }
        return normalized.length > 180 ? `${normalized.slice(0, 180)}...` : normalized;
    }

    ngOnInit() {
        if (this.coreStarted) {
            this.checFunction();
        }
    }

      private async checkSyncThrottled(): Promise<void> {
       if (this.isCheckingSync) {
           console.log('Sync check already in progress, skipping...');
           return;
       }

       this.isCheckingSync = true; // Lock the function
       try {
           console.log('Starting sync process...'); // Your console log to track sync start
           await this.checkSync(); // Actual sync logic
           console.log('Sync process completed successfully.'); // Log after the sync completes
       } catch (error) {
           console.error('Error during sync process:', error); // In case there is an error
       } finally {
           this.isCheckingSync = false; // Unlock the function after the sync is done
       }
    }

    private checFunction() {
        this.checkSyncThrottled(); // First run
        this.checkIntervalFunc = setInterval(() => this.checkSyncThrottled(), 5000); // Continue at intervals
    }

    private countETA(etaData: { stamp: number; blocks: number; }) {
        const prevStamp = this.prevEtaData.stamp;
        const prevBlocks = this.prevEtaData.blocks;
        const currentStamp = etaData.stamp;
        const currentBlocks = etaData.blocks;
        this.prevEtaData = etaData;
        if (!prevBlocks || !prevStamp || !currentStamp || !currentBlocks) return;
        const blocksInterval = currentBlocks - prevBlocks;
        const stampInterval = currentStamp - prevStamp;
        const msPerBlock = Math.round(stampInterval / blocksInterval);
        const remainingBlocks = this.networkBlocks - currentBlocks;
        const remainingms = msPerBlock * remainingBlocks;
        const minutes = Math.floor((remainingms / (1000 * 60)) % 60);
        const hours = Math.floor((remainingms / (1000 * 60 * 60)));
        if (remainingms > 0 && remainingms < 604800000 ) {
            const message =  hours > 0 ? `${hours} hours ${minutes} minutes` : `${minutes} minutes`;
            this.eta = `Remaining ~ ${message}`;
        } else {
            this.eta = 'Calculating Remaining Time ...';
        }
    }

    private countTlETA(etaData: { stamp: number; blocks: number; }) {
        const prevStamp = this.prevTlEtaData.stamp;
        const prevBlocks = this.prevTlEtaData.blocks;
        const currentStamp = etaData.stamp;
        const currentBlocks = etaData.blocks;
        this.prevTlEtaData = etaData;
        if (!prevBlocks || !prevStamp || !currentStamp || !currentBlocks || !this.tlTargetBlock) return;
        const blocksInterval = currentBlocks - prevBlocks;
        const stampInterval = currentStamp - prevStamp;
        if (blocksInterval <= 0 || stampInterval <= 0) return;
        const msPerBlock = Math.round(stampInterval / blocksInterval);
        const remainingBlocks = this.tlTargetBlock - currentBlocks;
        const remainingms = msPerBlock * remainingBlocks;
        const minutes = Math.floor((remainingms / (1000 * 60)) % 60);
        const hours = Math.floor((remainingms / (1000 * 60 * 60)));
        if (remainingms > 0 && remainingms < 604800000 ) {
            const message =  hours > 0 ? `${hours} hours ${minutes} minutes` : `${minutes} minutes`;
            this.tlEta = `Remaining ~ ${message}`;
        } else {
            this.tlEta = 'Waiting for TradeLayer parser status ...';
        }
    }

    private async checkTradelayerSync() {
        console.log('checking tl flag this sync '+this.rpcService.isTLStarted)
        console.log(Boolean(!this.rpcService.isTLStarted&&this.rpcService.isAbleToRpc == true))
        try {
            if (!this.rpcService.isTLStarted && this.rpcService.isAbleToRpc == true && this.nodeBlock){
                const result = await this.apiService.mainApi.initTradeLayer().toPromise();
                console.log('TL Wallet Listener init result: '+JSON.stringify(result))
                 // Adding a delay of 10 seconds between initTradeLayer and the next call
                await new Promise(resolve => setTimeout(resolve, 5000));  // 5-second delay

                if (result &&result.result==true&&!this.rpcService.isTLStarted) {
                    console.log('Initialization of listener succeeded');
                        const initRes = await this.apiService.newTlApi.rpc('init').toPromise();
                        if (initRes.error || !initRes.data) {
                            console.log('issue with init resolution '+JSON.stringify(initRes))
                            throw new Error(initRes.error || 'Undefined Error');
                        }
                        this.rpcService.isTLStarted = true;
                }
               
            }

            const syncRes = await this.apiService.mainApi.getTradeLayerSyncStatus().toPromise();
            const status = syncRes?.data;
            if (!status) {
                this.tlSyncStatus = null;
                this.tlMessage = 'TradeLayer parser status is unavailable.';
                this.tlReadyPercent = 0;
                this.tlEta = 'Waiting for TradeLayer parser status ...';
                return;
            }

            this.tlSyncStatus = status;
            this.tlMessage = this.formatDialogError(status.message || '', '');
            this.tlReadyPercent = Number(status.percent || 0);
            const nodeBlock = Number(status.nodeBlock || 0);
            const headerBlock = Number(status.headerBlock || status.chainTip || nodeBlock || 0);
            if (!this.rpcService.lastBlock && nodeBlock) this.rpcService.lastBlock = nodeBlock;
            if (!this.rpcService.headerBlock && headerBlock) this.rpcService.headerBlock = headerBlock;
            if (!this.rpcService.networkBlocks && headerBlock) this.rpcService.networkBlocks = headerBlock;
            this.rpcService.latestTlBlock = Number(
                status.currentHeight || status.processedHeight || status.trackHeight || 0
            );
            if (status.initialized) {
                this.rpcService.isTLStarted = true;
            } else if (status.listenerReachable) {
                this.rpcService.isTLStarted = false;
            }
            if (this.tlCurrentBlock > 0 && this.tlTargetBlock > 0) {
                this.countTlETA({ stamp: Date.now(), blocks: this.tlCurrentBlock });
            } else if (this.tlMessage) {
                this.tlEta = this.tlMessage;
            } else {
                this.tlEta = 'Waiting for TradeLayer parser status ...';
            }
            return;
        } catch (error: any) {
           console.log('error calling init '+JSON.stringify(error))
            const errorMessage = this.formatDialogError(error);
            this.tlSyncStatus = null;
            this.tlReadyPercent = 0;
            this.tlMessage = errorMessage;
            this.tlEta = errorMessage;
        }
    }

    private async checkIsAbleToRpcLoop() {
        let attempts = 0;
        const maxAttempts = 50; // You can increase this if you need a longer wait

        while (!this.isAbleToRpc && attempts < maxAttempts) {
            attempts++;
            console.log(`Checking RPC connection, attempt ${attempts}`);
            await this.checkIsAbleToRpc(); // Attempt to set the RPC flag

            if (!this.isAbleToRpc) {
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 2 seconds before retrying
            }
        }

        if (!this.isAbleToRpc) {
            throw new Error("Unable to establish RPC connection after multiple attempts.");
        }
    }


    private async checkSync() {
        try {
            await this.checkIsAbleToRpcLoop(); // Keep checking until RPC is ready
        } finally {
            await this.checkTradelayerSync();
        }
        if (!this.nodeBlock || !this.headerBlock) return;
        this.countETA({ stamp: Date.now(), blocks: this.nodeBlock });
        this.readyPercent = parseFloat((this.nodeBlock / this.headerBlock).toFixed(2)) * 100;
    }

    private async checkIsAbleToRpc() {
        try {
            if (this.isAbleToRpc) return;
            const res = await this.apiService.mainApi.rpcCall('getblockchaininfo').toPromise();
            const errMsg = String(res?.error || '').toLowerCase();
            const isTransient = errMsg.includes('econnrefused')
              || errMsg.includes('connection refused')
              || errMsg.includes('socket hang up')
              || errMsg.includes('etimedout')
              || errMsg.includes('loading block index')
              || errMsg.includes('rewinding blocks')
              || errMsg.includes('warming up');
            if (res.error && !isTransient) this.message = this.formatDialogError(res.error);
            if (isTransient) {
                this.message = 'Starting Litecoin daemon...';
                return;
            }
            if (!res.error && res.data) {
                const blocks = Number(res.data.blocks || 0);
                const headers = Number(res.data.headers || blocks);
                if (blocks) this.rpcService.lastBlock = blocks;
                if (headers) this.rpcService.headerBlock = headers;
                if (headers) this.rpcService.networkBlocks = headers;
                this.rpcService.isAbleToRpc = true;
                this.message = '';
                this.eta = 'Calculating Remaining Time ...';
            }
        } catch (error: any) {
            const errrorMessage = String(error?.message || error || '').toLowerCase();
            const isTransient = errrorMessage.includes('econnrefused')
              || errrorMessage.includes('connection refused')
              || errrorMessage.includes('socket hang up')
              || errrorMessage.includes('etimedout')
              || errrorMessage.includes('loading block index')
              || errrorMessage.includes('rewinding blocks')
              || errrorMessage.includes('warming up');
            this.message = isTransient ? 'Starting Litecoin daemon...' : this.formatDialogError(error);
        }
    }

    async terminate() {
        if (this.authService.isLoggedIn) {
            this.toastrService.warning('Please first logout');
            return;
        }
        if (!this.isAbleToRpc) return;
        this.loadingService.isLoading = true;
        const terminateRes = await this.rpcService.terminateNode();
        clearInterval(this.checkIntervalFunc);
        this.message = ' ';
    }

    ngOnDestroy() {
        clearInterval(this.checkIntervalFunc);
    }

    // ------
    public _defaultDirectoryCheckbox: boolean = true;
    public directory: string = '';
    public reindex: boolean = false;
    public startclean: boolean = false;
    public showAdvanced: boolean = false;
    public isDirectoryDialogOpen: boolean = false;
    public network: ENetwork = this.rpcService.NETWORK as ENetwork;

    get defaultDirectoryCheckbox() {
        return this._defaultDirectoryCheckbox;
    }

    set defaultDirectoryCheckbox(value: boolean) {
        this.directory = '';
        this._defaultDirectoryCheckbox = value;
    }

    openDirSelectDialog() {
        if (this.isDirectoryDialogOpen) return;
        this.isDirectoryDialogOpen = true;
        const unsubscribe = this.electronService.onMessage((message: any) => {
            const { event, data } = message;
            if (event !== 'selected-dir') return;
            unsubscribe();
            this.zone.run(() => {
                this.isDirectoryDialogOpen = false;
                if (data) {
                    this.directory = data || '';
                }
            });
        });
        this.electronService.emitEvent('open-dir-dialog');
    }

    toggleAdvanced() {
        this.showAdvanced = !this.showAdvanced;
        if (!this.showAdvanced) {
        this.reindex = false;
        this.startclean = false;
        }    
    }

    async startWalletNode() {
        const network = this.network;
        if (!network) return;
        const path = this.defaultDirectoryCheckbox ? '' : this.directory;
        const { reindex, startclean } = this;
        const flags = { reindex, startclean };
        this.loadingService.isLoading = true;
        await this.rpcService.startWalletNode(path, ENetwork[network], flags)
        .then(async res => {
            if (res.error || !res.data) {
            const configError = res.error.includes("Config file") && res.error.includes("doesn't exist in");
            if (configError) {
                this.dialogService.openDialog(DialogTypes.NEW_NODE, { data: { path }});
            } else {
                this.toastrService.error(this.formatDialogError(res.error), 'Starting Node Error');
            }
            } else {

                this.router.navigateByUrl('/');
                await this.checkIsAbleToRpc();
            }
        })
        .catch(error => {
            this.toastrService.error(this.formatDialogError(error), 'Error request');
        })
        .finally(() => {
            this.checFunction();
            this.loadingService.isLoading = false;
            this.eta = 'Calculating Remaining Time ...';
        });
    }
}
