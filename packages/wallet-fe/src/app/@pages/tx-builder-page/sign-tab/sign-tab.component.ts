import { Component, OnInit } from '@angular/core';
import { ToastrService } from 'ngx-toastr';
import { AuthService } from 'src/app/@core/services/auth.service';

@Component({
  selector: 'tl-sign-tab',
  templateUrl: './sign-tab.component.html',
  styleUrls: ['./sign-tab.component.scss']
})
export class SignTxTabComponent implements OnInit {
  output: string = '';
  input: string = '';

  constructor(
    private toastrService: ToastrService,
    private authService: AuthService,
  ) {}

  get keypairs() {
    return this.authService.listOfallAddresses;
  }

  get isLoggedIn() {
    return this.authService.isLoggedIn;
  }

  ngOnInit() { }

  async pasteClipboard() {
    const text = await navigator.clipboard.readText();
    this.input = text;
  }

  copyOutput() {
    if (!this.output) return;
    navigator.clipboard.writeText(this.output);
    this.toastrService.info('RawTX Copied to clipboard', 'Copied');
  }

  sign() {
    console.log('SIGN', this.input);
  }
}
