import { Component, OnInit } from '@angular/core';
import { ToastrService } from 'ngx-toastr';

@Component({
  selector: 'tl-send-tab',
  templateUrl: './send-tab.component.html',
  styleUrls: ['./send-tab.component.scss']
})
export class SendTxTabComponent implements OnInit {
  output: string = '';
  input: string = '';
  
  constructor(
    private toastrService: ToastrService,
  ) {}

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

  send() {
    console.log('SEND', this.input);
  }
}
