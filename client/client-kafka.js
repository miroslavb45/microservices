"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClientKafka = void 0;
const logger_service_1 = require("@nestjs/common/services/logger.service");
const load_package_util_1 = require("@nestjs/common/utils/load-package.util");
const shared_utils_1 = require("@nestjs/common/utils/shared.utils");
const constants_1 = require("../constants");
const kafka_response_deserializer_1 = require("../deserializers/kafka-response.deserializer");
const enums_1 = require("../enums");
const invalid_kafka_client_topic_exception_1 = require("../errors/invalid-kafka-client-topic.exception");
const helpers_1 = require("../helpers");
const kafka_request_serializer_1 = require("../serializers/kafka-request.serializer");
const client_proxy_1 = require("./client-proxy");
let kafkaPackage = {};
class ClientKafka extends client_proxy_1.ClientProxy {
    constructor(options) {
        super();
        this.options = options;
        this.client = null;
        this.consumer = null;
        this.producer = null;
        this.logger = new logger_service_1.Logger(ClientKafka.name);
        this.responsePatterns = [];
        this.consumerAssignments = {};
        const clientOptions = this.getOptionsProp(this.options, 'client') || {};
        const consumerOptions = this.getOptionsProp(this.options, 'consumer') || {};
        const postfixId = this.getOptionsProp(this.options, 'postfixId') || '-client';
        this.brokers = clientOptions.brokers || [constants_1.KAFKA_DEFAULT_BROKER];
        // Append a unique id to the clientId and groupId
        // so they don't collide with a microservices client
        this.clientId =
            (clientOptions.clientId || constants_1.KAFKA_DEFAULT_CLIENT) + postfixId;
        this.groupId = (consumerOptions.groupId || constants_1.KAFKA_DEFAULT_GROUP) + postfixId;
        kafkaPackage = load_package_util_1.loadPackage('kafkajs', ClientKafka.name, () => require('kafkajs'));
        this.initializeSerializer(options);
        this.initializeDeserializer(options);
    }
    subscribeToResponseOf(pattern) {
        const request = this.normalizePattern(pattern);
        this.responsePatterns.push(this.getResponsePatternName(request));
    }
    async close() {
        this.producer && (await this.producer.disconnect());
        this.consumer && (await this.consumer.disconnect());
        this.producer = null;
        this.consumer = null;
        this.client = null;
    }
    async connect() {
        if (this.client) {
            return this.producer;
        }
        this.client = this.createClient();
        const partitionAssigners = [
            (config) => new helpers_1.KafkaReplyPartitionAssigner(this, config),
        ];
        const consumerOptions = Object.assign({
            partitionAssigners,
        }, this.options.consumer || {}, {
            groupId: this.groupId,
        });
        this.producer = this.client.producer(this.options.producer || {});
        this.consumer = this.client.consumer(consumerOptions);
        // set member assignments on join and rebalance
        this.consumer.on(this.consumer.events.GROUP_JOIN, this.setConsumerAssignments.bind(this));
        await this.producer.connect();
        await this.consumer.connect();
        await this.bindTopics();
        return this.producer;
    }
    async bindTopics() {
        const consumerSubscribeOptions = this.options.subscribe || {};
        const subscribeTo = async (responsePattern) => this.consumer.subscribe(Object.assign({ topic: responsePattern }, consumerSubscribeOptions));
        await Promise.all(this.responsePatterns.map(subscribeTo));
        await this.consumer.run(Object.assign(this.options.run || {}, {
            eachMessage: this.createResponseCallback(),
        }));
    }
    createClient() {
        return new kafkaPackage.Kafka(Object.assign(this.options.client || {}, {
            clientId: this.clientId,
            brokers: this.brokers,
            logCreator: helpers_1.KafkaLogger.bind(null, this.logger),
        }));
    }
    createResponseCallback() {
        return (payload) => {
            const rawMessage = helpers_1.KafkaParser.parse(Object.assign(payload.message, {
                topic: payload.topic,
                partition: payload.partition,
            }));
            if (shared_utils_1.isUndefined(rawMessage.headers[enums_1.KafkaHeaders.CORRELATION_ID])) {
                return;
            }
            const { err, response, isDisposed, id } = this.deserializer.deserialize(rawMessage);
            const callback = this.routingMap.get(id);
            if (!callback) {
                return;
            }
            if (err || isDisposed) {
                return callback({
                    err,
                    response,
                    isDisposed,
                });
            }
            callback({
                err,
                response,
            });
        };
    }
    getConsumerAssignments() {
        return this.consumerAssignments;
    }
    dispatchEvent(packet) {
        const pattern = this.normalizePattern(packet.pattern);
        const outgoingEvent = this.serializer.serialize(packet.data);
        const message = Object.assign({
            topic: pattern,
            messages: [outgoingEvent],
        }, this.options.send || {});
        return this.producer.send(message);
    }
    getReplyTopicPartition(topic) {
        const minimumPartition = this.consumerAssignments[topic];
        if (shared_utils_1.isUndefined(minimumPartition)) {
            throw new invalid_kafka_client_topic_exception_1.InvalidKafkaClientTopicException(topic);
        }
        // get the minimum partition
        return minimumPartition.toString();
    }
    publish(partialPacket, callback) {
        try {
            const packet = this.assignPacketId(partialPacket);
            const pattern = this.normalizePattern(partialPacket.pattern);
            const replyTopic = this.getResponsePatternName(pattern);
            const replyPartition = this.getReplyTopicPartition(replyTopic);
            const serializedPacket = this.serializer.serialize(packet.data);
            serializedPacket.headers[enums_1.KafkaHeaders.CORRELATION_ID] = packet.id;
            serializedPacket.headers[enums_1.KafkaHeaders.REPLY_TOPIC] = replyTopic;
            serializedPacket.headers[enums_1.KafkaHeaders.REPLY_PARTITION] = replyPartition;
            this.routingMap.set(packet.id, callback);
            const message = Object.assign({
                topic: pattern,
                messages: [serializedPacket],
            }, this.options.send || {});
            this.producer.send(message).catch(err => callback({ err }));
            return () => this.routingMap.delete(packet.id);
        }
        catch (err) {
            callback({ err });
        }
    }
    getResponsePatternName(pattern) {
        return `${pattern}.reply`;
    }
    setConsumerAssignments(data) {
        const consumerAssignments = {};
        // only need to set the minimum
        Object.keys(data.payload.memberAssignment).forEach(memberId => {
            const minimumPartition = Math.min(...data.payload.memberAssignment[memberId]);
            consumerAssignments[memberId] = minimumPartition;
        });
        this.consumerAssignments = consumerAssignments;
    }
    initializeSerializer(options) {
        this.serializer =
            (options && options.serializer) || new kafka_request_serializer_1.KafkaRequestSerializer();
    }
    initializeDeserializer(options) {
        this.deserializer =
            (options && options.deserializer) || new kafka_response_deserializer_1.KafkaResponseDeserializer();
    }
}
exports.ClientKafka = ClientKafka;
