import { Component, OnInit } from '@angular/core';
import { FormBuilder, FormControl, FormGroup, Validators } from '@angular/forms';
import { ToastrService } from 'ngx-toastr';
import { RpcService } from 'src/app/@core/services/rpc.service';
import { TxsService } from 'src/app/@core/services/txs.service';

class Input {
  constructor(
    public prefix: string,
    public code: string,
    public type: string, 
    public required: boolean,
    public typeExpected: 'int' | 'str',
    ) {}
}

interface ITXType {
  rpc: string;
  inputs: Input[];
}

const txTypes: ITXType[] = [
  {
    rpc: 'tl_createpayload_attestation',
    inputs: [],
  },
  {
    rpc: 'tl_createpayload_simplesend',
    inputs: [
      new Input('Property ID','prop_id', 'NUMBER', true, 'int'),
      new Input('Amount', 'amount', 'NUMBER', true, 'str'),
    ],
  },
  {
    rpc: 'tl_createpayload_sendvesting',
    inputs: [
      new Input('Amount', 'amount', 'NUMBER', true, 'str'),
    ],
  }
];

@Component({
  selector: 'tl-build-tab',
  templateUrl: './build-tab.component.html',
  styleUrls: ['./build-tab.component.scss']
})

export class BuildTxTabComponent implements OnInit {

  output: string = '';
  sendAddress: string = '';
  receiveAddress: string = '';
  selectedTxType: ITXType | null = null;
  txTypeForm: FormGroup | null = null;

  constructor(
    private toastrService: ToastrService,
    private fb: FormBuilder,
    private rpcService: RpcService,
    private txService: TxsService,
  ) {}

  get transactionTypes() {
    return txTypes
  }

  get buildDisabled() {
    return !this.selectedTxType
    || !this.txTypeForm?.valid
    || !this.sendAddress
    || !this.receiveAddress;
  }

  ngOnInit() { }

  copyOutput() {
    if (!this.output) return;
    navigator.clipboard.writeText(this.output);
    this.toastrService.info('RawTX Copied to clipboard', 'Copied');
  }

  async build() {
    this.output = '';
    if (!this.selectedTxType || !this.txTypeForm?.valid) return;
    const payloadParams = this.selectedTxType.inputs.map(i => {
      const value = this.txTypeForm?.get(i.code)?.value;
      if (i.typeExpected === 'str') return value.toString();
      return parseFloat(value);
    });
    try {
      const payloadRes = await this.rpcService.rpc(this.selectedTxType.rpc, payloadParams);
      if (payloadRes.error || !payloadRes.data) throw new Error(payloadRes.error || 'Undefined Error. Code 1');
      const payload = payloadRes.data;
      const sendAddress = this.sendAddress;
      const receiveAddress = this.receiveAddress;
      const buildOptions = {
        fromKeyPair: { address: sendAddress },
        toKeyPair: { address: receiveAddress },
        payload,
      }
      const buildRes = await this.txService.buildTx(buildOptions);
      if (buildRes.error || !buildRes.data?.rawtx) throw new Error(buildRes.error || 'Undefined Error. Code 2');
      this.output = buildRes.data.rawtx;
      this.clearFields();
    } catch (error: any) {
      this.output = `Error: ${error.message || error || 'Undefined'}`;
    }
  }

  onTypeChange() {
    this.buildTransactionTypeForm()
  }

  private clearFields() {
    this.buildTransactionTypeForm();
    this.sendAddress = '';
    this.receiveAddress = '';
    this.txTypeForm?.reset();
  }

  private buildTransactionTypeForm() {
    if (!this.selectedTxType) return;
    const buildFormFromInputs = (inputs: Input[]) => {
      const newObj: any = {};
        inputs.forEach(i => {
        const { required } = i;
        newObj[i.code] = new FormControl();
        if (required) newObj[i.code].setValidators([Validators.required]);
      });
      return newObj;
    }
    const group = buildFormFromInputs(this.selectedTxType.inputs);
    this.txTypeForm = this.fb.group(group);
  }
}