import { Component, OnInit } from '@angular/core';
import { ToastrService } from 'ngx-toastr';

@Component({
  selector: 'tl-build-tab',
  templateUrl: './build-tab.component.html',
  styleUrls: ['./build-tab.component.scss']
})
export class BuildTxTabComponent implements OnInit {
  output: string = '';

  constructor(
    private toastrService: ToastrService,
  ) {}

  ngOnInit() { }

  copyOutput() {
    if (!this.output) return;
    navigator.clipboard.writeText(this.output);
    this.toastrService.info('RawTX Copied to clipboard', 'Copied');
  }

  build() {
    console.log('SEND');
  }
}
