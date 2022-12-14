import { Pipe, PipeTransform } from '@angular/core';
import * as moment from 'moment';

@Pipe({
  name: 'dateFormat'
})
export class DateFormatPipe implements PipeTransform {
    transform(a: number) {
        if (!a) return '-';
        return moment(a).format('DD-MM-YYYY HH:MM');
    }
}
