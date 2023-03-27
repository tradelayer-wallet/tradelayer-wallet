import { Component, OnInit } from '@angular/core';
import { ToastrService } from 'ngx-toastr';

@Component({
  selector: 'tl-decode-tab',
  templateUrl: './decode-tab.component.html',
  styleUrls: ['./decode-tab.component.scss']
})
export class DecodeTxTabComponent implements OnInit {
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

  decode() {
    console.log('Decode', this.input);
  }
}
