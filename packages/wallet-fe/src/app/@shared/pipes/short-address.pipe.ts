import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'shortAddress'
})
export class ShortAddressPipe implements PipeTransform {
    transform(a: string) {
        if (a.length < 4) return a;
        return `${a.slice(0, 4)}...${a.slice(-4)}`
    }
}
