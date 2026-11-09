#import <Foundation/Foundation.h>
#import <IOBluetooth/IOBluetooth.h>
#import <IOBluetoothUI/IOBluetoothUI.h>
// UI functions are called on AppKit's main thread; channel objects stay on their worker run loop.
char *classic_choose(int pair) {
    @autoreleasepool {
        NSArray *results = nil;
        if (pair) {
            IOBluetoothPairingController *controller = [IOBluetoothPairingController pairingController];
            [controller addAllowedUUID:[IOBluetoothSDPUUID uuid16:0x1101]];
            if ([controller runModal] != kIOBluetoothUISuccess) return NULL;
            results = [controller getResults];
        } else {
            IOBluetoothDeviceSelectorController *controller = [IOBluetoothDeviceSelectorController deviceSelector];
            [controller addAllowedUUID:[IOBluetoothSDPUUID uuid16:0x1101]];
            if ([controller runModal] != kIOBluetoothUISuccess) return NULL;
            results = [controller getResults];
        }
        IOBluetoothDevice *device = [results firstObject];
        if (!device) return NULL;
        NSDictionary *value = @{ @"address": [device addressString], @"name": [device name] ?: @"Classic SPP", @"paired": @([device isPaired]) };
        NSData *json = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
        return strdup([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
    }
}
@interface ClassicChannel : NSObject <IOBluetoothRFCOMMChannelDelegate>
@property(nonatomic, strong) IOBluetoothRFCOMMChannel *channel;
@property(nonatomic, strong) NSMutableData *received;
@property(nonatomic) BOOL lost;
@property(nonatomic) BOOL closed;
@property(nonatomic) BOOL sdpDone;
@property(nonatomic) IOReturn sdpStatus;
@end
@implementation ClassicChannel
- (void)rfcommChannelData:(IOBluetoothRFCOMMChannel *)channel data:(void *)data length:(size_t)length {
    if (self.received.length + length > 1048576) { self.lost = YES; return; }
    [self.received appendBytes:data length:length];
}
- (void)rfcommChannelClosed:(IOBluetoothRFCOMMChannel *)channel { self.closed = YES; self.lost = YES; }
- (void)sdpQueryComplete:(IOBluetoothDevice *)device status:(IOReturn)status { self.sdpStatus = status; self.sdpDone = YES; }
@end
static void pump(void) { [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]]; }
typedef int (*ClassicCurrent)(void *);
void *classic_open(const char *address, ClassicCurrent current, void *context) {
    @autoreleasepool {
        IOBluetoothDevice *device = [IOBluetoothDevice deviceWithAddressString:[NSString stringWithUTF8String:address]];
        if (!device || ![device isPaired]) return NULL; // Pairing is always a separate user-interactive action.
        ClassicChannel *state = [ClassicChannel new]; state.received = [NSMutableData new];
        if ([device performSDPQuery:state] != kIOReturnSuccess) return NULL;
        // The SDK exposes no SDP cancellation. Retain the delegate and its run loop until
        // completion, even after the owner is invalidated. Rust keeps the lifetime lease;
        // release/upgrade must report busy, never free this callback target on a timer.
        while (!state.sdpDone) pump();
        if (state.sdpStatus != kIOReturnSuccess || !current(context)) return NULL;
        BluetoothRFCOMMChannelID cid = 0;
        IOBluetoothSDPServiceRecord *record = [device getServiceRecordForUUID:[IOBluetoothSDPUUID uuid16:0x1101]];
        if (!record || [record getRFCOMMChannelID:&cid] != kIOReturnSuccess || !cid) return NULL;
        IOBluetoothRFCOMMChannel *channel = nil;
        if ([device openRFCOMMChannelSync:&channel withChannelID:cid delegate:state] != kIOReturnSuccess || !channel) return NULL;
        state.channel = channel;
        // SDK explicitly returns an already-retained channel despite its selector naming.
        CFRelease((__bridge CFTypeRef)channel);
        return (__bridge_retained void *)state;
    }
}
int classic_read(void *handle, unsigned char *out, unsigned int capacity) {
    @autoreleasepool {
        ClassicChannel *state = (__bridge ClassicChannel *)handle; pump();
        if (state.lost || !state.channel.isOpen) return -1;
        NSUInteger n = MIN(capacity, state.received.length);
        if (n) { memcpy(out, state.received.bytes, n); [state.received replaceBytesInRange:NSMakeRange(0,n) withBytes:NULL length:0]; }
        return (int)n;
    }
}
int classic_write(void *handle, const unsigned char *bytes, unsigned int length, ClassicCurrent current, void *context) {
    @autoreleasepool {
        ClassicChannel *state = (__bridge ClassicChannel *)handle;
        if (state.lost || !state.channel.isOpen) return -1;
        unsigned int mtu = [state.channel getMTU]; if (!mtu) return -1;
        for (unsigned int i=0;i<length;) {
            if (!current(context)) return -1;
            unsigned int n = MIN(mtu,length-i);
            if ([state.channel writeSync:(void *)(bytes+i) length:(UInt16)n] != kIOReturnSuccess) return -1;
            i += n;
        }
        return 0;
    }
}
void classic_close(void *handle) {
    @autoreleasepool {
        ClassicChannel *state = (__bridge_transfer ClassicChannel *)handle;
        // A failed close is not physical release. Keep the owner lease alive while retrying.
        while (!state.closed) {
            if ([state.channel closeChannel] == kIOReturnSuccess) break;
            // A remote-close callback is authoritative even when closeChannel reports not-open.
            // lost (including overflow) and isOpen==NO are NOT proof of physical closure.
            pump();
        }
        [state.channel setDelegate:nil]; state.channel = nil;
    }
}
