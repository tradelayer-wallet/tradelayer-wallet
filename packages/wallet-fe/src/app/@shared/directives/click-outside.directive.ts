import { Directive, ElementRef, AfterViewInit, OnDestroy, Input, EventEmitter, Output } from '@angular/core';
import { fromEvent, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

  @Directive({
    selector: '[clickOutside]',
  })

  export class ClickOutsideDirective implements AfterViewInit, OnDestroy {
    // TODO: Add Types
    private _onDestroy$ = new Subject<void>();
    @Output() clickOutside = new EventEmitter();
    constructor(private _eref: ElementRef) {}

    ngAfterViewInit() {
        setTimeout(() => {
        fromEvent(document, 'click')
        .pipe(takeUntil(this._onDestroy$))
        .subscribe((e: any) => {
          if (!this._eref.nativeElement.contains(e.target)) {
            this.clickOutside.emit();
          }
        });
        }, 0);
    }
    ngOnDestroy() {
        this._onDestroy$.next();
        this._onDestroy$.complete();
    }
}
