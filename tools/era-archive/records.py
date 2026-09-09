"""Read bounded legacy and compact ZDO records without starting or rewriting a game.

Only opaque byte arrays and the original inventory string are materialized here. The
primary Java parser owns classification and decoded typed fields; these supplemental
payloads retain information its analytics schema historically represented by length.
"""
import mmap
import struct


def stable_hash(text):
    a=b=5381
    for i,c in enumerate(text):
        if i%2:a=((a*33)^ord(c))&0xffffffff
        else:b=((b*33)^ord(c))&0xffffffff
    value=(b+a*1566083941)&0xffffffff
    return value if value<2**31 else value-2**32


ITEMS=stable_hash('items')


def count(data, offset, version):
    first=data[offset];offset+=1
    if version<31:
        size=1 if first<128 else 2 if first<224 else 3
        value=ord(bytes(data[offset-1:offset-1+size]).decode('utf-8'))
        return value,offset-1+size
    if version>=33 and first&128:return ((first&127)<<8)|data[offset],offset+1
    return first,offset


def string_end(data, offset):
    length=shift=0
    while True:
        if shift>28:raise ValueError('Invalid string length')
        value=data[offset];offset+=1;length|=(value&127)<<shift
        if not value&128:break
        shift+=7
    return offset,offset+length


def records(path, wanted_prefabs=None):
    """Yield (index,prefab,x,y,z,payloads) in source order. Validate every record."""
    with open(path,'rb') as handle, mmap.mmap(handle.fileno(),0,access=mmap.ACCESS_READ) as data:
        version,_,_,_,total=struct.unpack_from('<idqii',data)
        if not 29<=version<=37 or total<0:raise ValueError('Unsupported world header')
        offset=28
        for index in range(total):
            try:
                payloads=[];end=None
                if version<31:
                    length=struct.unpack_from('<i',data,offset+12)[0]
                    start=offset+16;end=start+length
                    if length<78 or end>len(data):raise ValueError('Invalid legacy package length')
                    prefab=struct.unpack_from('<i',data,start+31)[0]
                    x,y,z=struct.unpack_from('<fff',data,start+43)
                    offset=start+71;flags=254
                else:
                    flags=struct.unpack_from('<H',data,offset)[0]
                    x,y,z=struct.unpack_from('<fff',data,offset+6)
                    prefab=struct.unpack_from('<i',data,offset+18)[0]
                    offset+=22
                    if flags&4096:offset+=12
                    if flags&1:offset+=5
                wanted=wanted_prefabs is None or prefab in wanted_prefabs
                for bit,stride in ((2,8),(4,16),(8,20),(16,8),(32,12)):
                    if flags&bit:
                        n,offset=count(data,offset,version);offset+=n*stride
                if flags&64:
                    n,offset=count(data,offset,version)
                    for _ in range(n):
                        key=struct.unpack_from('<i',data,offset)[0];offset+=4
                        start,offset=string_end(data,offset)
                        if offset>len(data) or (end is not None and offset>end):raise ValueError('Truncated string')
                        if wanted and key==ITEMS:payloads.append(('string',key,bytes(data[start:offset]).decode('utf-8')))
                if flags&128:
                    n,offset=count(data,offset,version)
                    for _ in range(n):
                        key,length=struct.unpack_from('<ii',data,offset);offset+=8
                        if length<0 or offset+length>len(data) or (end is not None and offset+length>end):raise ValueError('Invalid byte array')
                        if wanted:payloads.append(('bytearray',key,bytes(data[offset:offset+length])))
                        offset+=length
                if offset>len(data) or (end is not None and offset!=end):raise ValueError('Record boundary mismatch')
                if wanted:yield index,prefab,x,y,z,payloads
            except (IndexError,struct.error,UnicodeError,ValueError) as error:
                raise ValueError(f'ZDO {index} at byte {offset}: {error}') from error
